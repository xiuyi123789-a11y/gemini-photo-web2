"""Local CPU segmentation. No network access, downloads, provider SDK or credentials.
MobileSAM must be provisioned explicitly; uncertainty is a terminal local failure.
"""
import base64
import json
import math
import os
import sys

if os.environ.get('REPLICATION_VISION_PACKAGES'):
    sys.path.insert(0, os.environ['REPLICATION_VISION_PACKAGES'])


def main():
    import cv2
    import numpy as np
    import torch
    from mobile_sam import sam_model_registry, SamPredictor
    torch.set_num_threads(max(1, min(4, int(os.environ.get('REPLICATION_VISION_THREADS', '2')))))
    cv2.setNumThreads(1)
    request = json.load(sys.stdin)
    if request.get('probe'):
        checkpoint=os.environ.get('REPLICATION_SAM_CHECKPOINT')
        return {'ready':bool(checkpoint and os.path.isfile(checkpoint))}
    def decode(value, gray=False):
        return cv2.imdecode(np.frombuffer(base64.b64decode(value), np.uint8), cv2.IMREAD_GRAYSCALE if gray else cv2.IMREAD_COLOR)
    def encode(value):
        return base64.b64encode(cv2.imencode('.png', value.astype(np.uint8))[1]).decode('ascii')
    source, raw = decode(request['source']), decode(request['generated'])
    h, w = source.shape[:2]
    if h*w > 32*1024*1024:
        raise ValueError('SEGMENTATION_INVALID')
    ratio_error = abs(math.log((raw.shape[1]/raw.shape[0])/(w/h)))
    if ratio_error > .015:
        return {'error': 'ALIGNMENT_UNRELIABLE'}
    scale = min(w/raw.shape[1], h/raw.shape[0])
    normalized = cv2.warpAffine(raw, np.float32([[scale, 0, (w-raw.shape[1]*scale)/2], [0, scale, (h-raw.shape[0]*scale)/2]]), (w, h))
    # Match independent background features. Object boxes are exclusions, never cut masks.
    work_scale = min(1., 1024/max(w, h)); sw, sh = round(w*work_scale), round(h*work_scale)
    a, b = [cv2.resize(im, (sw, sh)) for im in [source, normalized]]
    background = np.full((sh, sw), 255, np.uint8)
    for subject in request['subjects']:
        x, y, bw, bh = subject['bbox']
        cv2.rectangle(background, (max(0, round((x-.05)*sw)), max(0, round((y-.05)*sh))), (min(sw-1, round((x+bw+.05)*sw)), min(sh-1, round((y+bh+.05)*sh))), 0, -1)
    orb = cv2.ORB_create(nfeatures=3500)
    k1, d1 = orb.detectAndCompute(a, background); k2, d2 = orb.detectAndCompute(b, background)
    if d1 is None or d2 is None:
        return {'error': 'ALIGNMENT_UNRELIABLE'}
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(d2, d1, k=2)
    good = [p[0] for p in matches if len(p)==2 and p[0].distance < .7*p[1].distance]
    if len(good) < 16:
        return {'error': 'ALIGNMENT_UNRELIABLE'}
    src = np.float32([k2[m.queryIdx].pt for m in good]); dst = np.float32([k1[m.trainIdx].pt for m in good])
    matrix, inlier = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=1.8, maxIters=3000)
    if matrix is None or inlier is None:
        return {'error': 'ALIGNMENT_UNRELIABLE'}
    kept = inlier.ravel().astype(bool); error = float(np.median(np.linalg.norm(cv2.transform(src[None], matrix)[0][kept]-dst[kept], axis=1)))
    coverage = len(set((min(2, int(x/sw*3)), min(2, int(y/sh*3))) for x,y in dst[kept]))
    alignment = {'verified': int(kept.sum())>=16 and coverage>=3 and float(kept.mean())>=.5,
                 'inliers': int(kept.sum()), 'coverage': coverage, 'error': error,
                 'shift': float(np.linalg.norm(matrix[:,2])/max(sw,sh)),
                 'scaleError': float(math.hypot(matrix[0,0], matrix[1,0])-1), 'rotation': float(math.degrees(math.atan2(matrix[1,0],matrix[0,0])))}
    if not alignment['verified'] or alignment['shift']>.025 or abs(alignment['scaleError'])>.015 or abs(alignment['rotation'])>1:
        return {'alignment': alignment}
    matrix[:,2] /= work_scale
    aligned = cv2.warpAffine(normalized, matrix, (w,h))
    checkpoint = os.environ.get('REPLICATION_SAM_CHECKPOINT')
    if not checkpoint or not os.path.isfile(checkpoint):
        return {'error': 'SEGMENTATION_UNAVAILABLE'}
    predictor = SamPredictor(sam_model_registry['vit_t'](checkpoint=checkpoint).eval().to('cpu'))
    selection = decode(request['selectionMask'], True)>127
    hints = request.get('hints', [])
    def segment(image_name, subject, seed):
        x,y,bw,bh = subject['bbox']
        points, labels = [], []
        local = seed.copy()
        gate = np.zeros((h,w),np.uint8); cv2.rectangle(gate,(round(x*w),round(y*h)),(min(w-1,round((x+bw)*w)),min(h-1,round((y+bh)*h))),1,-1)
        local &= gate.astype(bool)
        if local.any():
            distance = cv2.distanceTransform(local.astype(np.uint8),cv2.DIST_L2,3)
            py,px = np.unravel_index(np.argmax(distance),distance.shape); points.append([int(px),int(py)]); labels.append(1)
        else:
            points.append([(x+bw/2)*w,(y+bh/2)*h]); labels.append(1)
        ys,xs=np.where(local)
        if len(xs):
            x0,y0,x1,y1=min(x*w,int(xs.min())),min(y*h,int(ys.min())),max((x+bw)*w,int(xs.max())),max((y+bh)*h,int(ys.max()))
        else:
            x0,y0,x1,y1=x*w,y*h,(x+bw)*w,(y+bh)*h
        # Context box is a decoder prompt, NOT a raster clipping boundary.
        margin=.12 if image_name=='source' else .3
        dx,dy=(x1-x0)*margin,(y1-y0)*margin
        prompt_box=np.float32([max(0,x0-dx),max(0,y0-dy),min(w-1,x1+dx),min(h-1,y1+dy)])
        prompt_area=(prompt_box[2]-prompt_box[0])*(prompt_box[3]-prompt_box[1])
        for hint in hints:
            if hint['kind']=='occlusion' and hint['image']=='source' and hint['instanceId']==subject['instance_id']:
                points.append([hint['x']*w,hint['y']*h]);labels.append(0)
            if hint['image']==image_name and hint['instanceId']==subject['instance_id'] and hint['kind'] in ['foreground','background']:
                point=[hint['x']*w,hint['y']*h]
                if image_name=='generated':
                    point=[(hint['x']*raw.shape[1])*scale+(w-raw.shape[1]*scale)/2,(hint['y']*raw.shape[0])*scale+(h-raw.shape[0]*scale)/2]
                    point=(matrix[:,:2]@np.float32(point)+matrix[:,2]).tolist()
                points.append(point); labels.append(1 if hint['kind']=='foreground' else 0)
        masks,scores,logits=predictor.predict(point_coords=np.float32(points),point_labels=np.int32(labels),box=prompt_box,multimask_output=True)
        candidates=[]
        for mask,score,logit in zip(masks,scores,logits):
            area=int(mask.sum()); inter=int((mask & gate.astype(bool)).sum()); border=bool(mask[0,:].any() or mask[-1,:].any() or mask[:,0].any() or mask[:,-1].any())
            stability=float((logit>1).sum()/max(1,(logit>-1).sum()))
            if area>=max(8,prompt_area*.12) and area<h*w*.45 and inter/max(1,area)>.35 and not border:
                candidates.append((float(score),stability,mask))
        if not candidates:
            raise ValueError('CONTOUR_UNCERTAIN')
        stable=[v for v in candidates if v[0]>=.88 and v[1]>=.9]
        score,stability,mask=max(stable or candidates,key=lambda v:v[0])
        return mask,float(score),stability
    predictor.set_image(cv2.cvtColor(source,cv2.COLOR_BGR2RGB))
    selected=request['selectedInstances']; old={}; protected=np.zeros((h,w),bool)
    for subject in request['subjects']:
        mask,score,stability=segment('source',subject,selection)
        if score<.88 or stability<.9:
            raise ValueError('CONTOUR_UNCERTAIN')
        if subject['instance_id'] in selected:
            old[subject['instance_id']]=(mask,score,stability)
        else:
            protected |= mask
    occlusion=np.zeros((h,w),bool)
    for hint in hints:
        if hint['kind']=='occlusion' and hint['image']=='source':
            masks,scores,logits=predictor.predict(point_coords=np.float32([[hint['x']*w,hint['y']*h]]),point_labels=np.int32([1]),multimask_output=True)
            old_union=np.zeros((h,w),bool)
            for v in old.values():old_union |= v[0]
            candidates=[i for i,m in enumerate(masks) if scores[i]>=.88 and int(m.sum())<h*w*.35 and int((m&old_union).sum())/max(1,int(old_union.sum()))<.02 and (logits[i]>1).sum()/max(1,(logits[i]>-1).sum())>=.9]
            if not candidates:
                raise ValueError('OCCLUSION_UNCERTAIN')
            best=max(candidates,key=lambda i:int(masks[i].sum()))
            occlusion |= masks[best]
    occlusion_resolved=all(not s.get('occluders') or any(t['kind']=='occlusion' and t['instanceId']==s['instance_id'] for t in hints) for s in request['subjects'] if s['instance_id'] in selected)
    predictor.set_image(cv2.cvtColor(aligned,cv2.COLOR_BGR2RGB))
    instances=[]; source_union=np.zeros((h,w),bool); generated_union=np.zeros((h,w),bool)
    for subject in request['subjects']:
        sid=subject['instance_id']
        if sid not in selected: continue
        previous,score,stability=old[sid]
        mask,new_score,new_stability=segment('generated',subject,previous)
        overlap=int((mask & previous).sum())/max(1,min(int(mask.sum()),int(previous.sum())))
        instances.append({'instanceId':sid,'sourceObjectMask':encode(previous*255),'generatedObjectMask':encode(mask*255),'confidence':min(score,new_score),'stability':min(stability,new_stability),'matched':overlap>.25,'borderTouch':False})
        source_union |= previous; generated_union |= mask
    # Check only known background around the object. This is restoration evidence,
    # never an object segmentation based on a pixel-difference threshold.
    known=~(source_union|generated_union|protected|occlusion)
    ring=cv2.dilate((source_union|generated_union).astype(np.uint8),np.ones((9,9),np.uint8)).astype(bool)&known
    bg_error=float(np.abs(source.astype(np.float32)-aligned.astype(np.float32))[ring].mean()) if ring.any() else 255.
    return {'alignment':alignment,'alignedImage':encode(aligned),'instances':instances,'protectedMask':encode(protected*255),'occlusionMask':encode(occlusion*255),
            'occlusionResolved':occlusion_resolved,'restorationVerified':bg_error<12,'restorationBoundaryError':bg_error}


try:
    result=main()
except ImportError:
    result={'error':'SEGMENTATION_UNAVAILABLE'}
except (ValueError,KeyError) as exc:
    reason=str(exc)
    result={'error':reason if reason in ['CONTOUR_UNCERTAIN','OCCLUSION_UNCERTAIN','ALIGNMENT_UNRELIABLE'] else 'SEGMENTATION_FAILED'}
except Exception:
    result={'error':'SEGMENTATION_FAILED'}
print(json.dumps(result,separators=(',',':')))
