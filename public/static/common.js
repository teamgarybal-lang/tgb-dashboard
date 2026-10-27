const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opts={}){const o={headers:{}};if(opts.body!==undefined){o.method=opts.method||'POST';o.headers['Content-Type']='application/json';o.body=JSON.stringify(opts.body)}else if(opts.method)o.method=opts.method;
 const r=await fetch(url,o);if(r.status===401){location.href='/login';throw new Error('signed out')}const j=r.headers.get('content-type')?.includes('json')?await r.json():await r.text();if(!r.ok)throw new Error(j.error||'Error');return j}
const fmtWeek=(a,b)=>{const f=d=>new Date(d+'T00:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'short'});return f(a)+' – '+f(b)};
async function logout(){await api('/api/logout',{body:{}});location.href='/login'}
async function changePw(){const c=prompt('Current password');if(c===null)return;const n=prompt('New password (8+ characters)');if(!n)return;try{await api('/api/password',{body:{current:c,next:n}});alert('Password changed');location.reload()}catch(e){alert(e.message)}}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
