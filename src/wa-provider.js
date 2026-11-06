// API contracts adapted from RevUp's providers/zernio.py and receptionist/sending.py.
// Every request uses the tenant's own key. No shared-key fallback.
const BASE='https://zernio.com/api/v1';
export async function messagingRequest(key,path,{method='GET',body,fetchImpl=fetch}={}){
 if(!key)throw Error('Connection unavailable.');
 const r=await fetchImpl(BASE+path,{method,headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 if(!r.ok){if(r.status===402)throw Error('Free connection unavailable. No payment was made.');if([401,403].includes(r.status))throw Error('Key or free allowance unavailable.');throw Error('Messaging service unavailable.');}
 return r.status===204?{}:r.json();
}
export function secureConnectUrl(value){try{const u=new URL(value);if(u.protocol==='https:'&&['zernio.com','www.zernio.com','facebook.com','www.facebook.com'].includes(u.hostname))return u.href;}catch{}throw Error('Invalid connection response.');}
