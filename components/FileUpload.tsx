
import React, { useCallback, useState } from 'react';
import { UploadIcon } from './IconComponents';
import { ImageFile } from '../types';

interface FileUploadProps {
  onFilesSelected: (files: ImageFile[]) => void;
  multiple?: boolean;
  accept?: string;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onFilesSelected, multiple = false, accept = 'image/*' }) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback((files: FileList | null) => {
    if (files) {
      const fileArray = Array.from(files);
      const imageFiles = fileArray.map(file => ({
        file,
        preview: URL.createObjectURL(file)
      }));
      onFilesSelected(imageFiles);
    }
  }, [onFilesSelected]);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative border-2 border-dashed rounded-3xl p-12 text-center transition-all duration-300 group cursor-pointer ${isDragging ? 'border-blue-500 bg-blue-50 scale-[1.01]' : 'border-slate-200 hover:border-blue-400 hover:bg-white/70'}`}
    >
      <input
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={onFileChange}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      <div className="flex flex-col items-center relative z-0 pointer-events-none">
        <div className={`p-4 rounded-full mb-4 transition-colors ${isDragging ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 group-hover:bg-blue-50 group-hover:text-blue-700'}`}>
             <UploadIcon className="h-10 w-10" />
        </div>
        <p className="mt-2 text-lg text-slate-800 font-semibold">
          拖放图片到此处，或 <span className="text-blue-700 group-hover:underline">点击浏览</span>
        </p>
        <p className="text-sm text-slate-500 mt-1">支持 JPEG, PNG, WEBP</p>
      </div>
    </div>
  );
};
