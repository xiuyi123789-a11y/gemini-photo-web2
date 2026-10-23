// Every npm-test subprocess is denied real outbound HTTP, including paid model APIs.
const original=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href);
  if(url.protocol==='data:'&&url.href.startsWith('data:image/'))return original(input,options);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('TEST_EXTERNAL_FETCH_BLOCKED');
  return original(input,options);
};
