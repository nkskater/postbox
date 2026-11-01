/** Runtime template contains no definition-derived executable strings; descriptors are JSON data. */
export const TYPESCRIPT_RUNTIME = String.raw`
export class ApiError extends Error {
 constructor(kind, message, details={}) { super(message); this.name='ApiError'; this.kind=kind; Object.assign(this,details); }
}
export class Client {
 constructor(config) {
  const base=new URL(config.baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query or fragment');
  this.config={timeoutMs:30000,...config,baseUrl:base.toString().replace(/\/$/,'')};
  if(!Number.isFinite(this.config.timeoutMs)||this.config.timeoutMs<1)throw new TypeError('timeoutMs must be positive');
 }
 async request(operation, options={}) {
  const descriptor=Object.hasOwn(OPERATIONS,operation)?OPERATIONS[operation]:undefined;if(!descriptor)throw new TypeError('Unknown operation');
  let path=descriptor.path.replace(/\{([^{}]+)\}/g,(_match,key)=>{const value=Object.hasOwn(options.path??{},key)?options.path[key]:undefined;if(value===undefined||value===null||value===''||value==='.'||value==='..'||String(value).includes('{{'))throw new TypeError('Missing or unresolved path parameter: '+key);return encodeURIComponent(String(value));});
  const url=new URL(this.config.baseUrl+path);for(const [key,value] of Object.entries(options.query??{})){if(value===undefined||value===null)continue;for(const item of Array.isArray(value)?value:[value])url.searchParams.append(key,String(item));}
  const headers={...this.config.headers,...options.headers};let body;
  if(options.body!==undefined){if(descriptor.bodyMode==='json'){body=JSON.stringify(options.body);if(!Object.keys(headers).some(key=>key.toLowerCase()==='content-type'))headers['Content-Type']='application/json';}else if(descriptor.bodyMode==='urlencoded'){body=new URLSearchParams(Object.entries(options.body).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(item=>[key,String(item)]))).toString();headers['Content-Type']='application/x-www-form-urlencoded';}else body=String(options.body);}
  const context={method:descriptor.method,url:url.toString(),headers,body};const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(new Error('Request timed out')),this.config.timeoutMs);const abort=()=>controller.abort(options.signal?.reason);if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
  try {
   if(this.config.auth)await this.config.auth(context);
   const response=await(this.config.fetch??globalThis.fetch)(context.url,{method:context.method,headers:context.headers,body:context.body,signal:controller.signal,redirect:'manual'});const text=await response.text();let data=text||null;
   if(text&&/json/i.test(response.headers.get('content-type')??'')){try{data=JSON.parse(text);}catch{throw new ApiError('decode','Response is not valid JSON',{status:response.status});}}
   if(!response.ok)throw new ApiError('http','HTTP '+response.status,{status:response.status,body:data,headers:Object.fromEntries(response.headers)});
   return data;
  } catch(error) {const failure=error instanceof ApiError?error:new ApiError('network','Request failed',{cause:error});if(this.config.onError)await this.config.onError(failure,context);throw failure;}
  finally {clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
 }
 async *pages(operation, initial, next, maxPages=100) {
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>10000)throw new TypeError('maxPages must be between 1 and 10000');let options=initial;
  for(let index=0;index<maxPages;index++){const value=await operation(options);yield value;const following=await next(value,options,index);if(following===null||following===undefined)return;options=following;}
  throw new ApiError('pagination','Pagination exceeded maxPages');
 }
}
`;
