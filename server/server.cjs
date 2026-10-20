const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {imageType,readImage}=require('./uploads.cjs');
const {DatabaseSync}=require('node:sqlite');
const seedEvents=require('../dist/events.js');
const auth=require('./auth.cjs');
const locale=require('../dist/i18n.js');
const root=path.resolve(__dirname,'../dist');
const dataDir=path.resolve(process.env.DATA_DIR||path.join(__dirname,'../data'));fs.mkdirSync(dataDir,{recursive:true});
const uploadDir=path.join(dataDir,'uploads');fs.mkdirSync(uploadDir,{recursive:true});
const db=new DatabaseSync(path.join(dataDir,'races.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,distance TEXT NOT NULL,email_consent INTEGER NOT NULL,whatsapp_consent INTEGER NOT NULL,created_at TEXT NOT NULL,cancel_token TEXT NOT NULL UNIQUE,cancelled INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,email)); CREATE TABLE IF NOT EXISTS notifications (registration_id TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt TEXT,last_error TEXT,sent_at TEXT,PRIMARY KEY(registration_id,channel));`);
auth.initAuth(db);
if(!db.prepare('PRAGMA table_info(registrations)').all().some(c=>c.name==='language'))db.exec("ALTER TABLE registrations ADD COLUMN language TEXT NOT NULL DEFAULT 'ar'");
db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY,extension TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS registrations_active_created ON registrations(cancelled,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS registrations_event_active ON registrations(event_id,cancelled,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status,next_attempt,registration_id);
PRAGMA busy_timeout=5000;`);
if (!db.prepare('SELECT 1 FROM events LIMIT 1').get()) {
 const insert=db.prepare('INSERT INTO events (id,data) VALUES (?,?)');
 db.exec('BEGIN');for(const e of seedEvents)insert.run(e.id,JSON.stringify(e));db.exec('COMMIT');
}
// Archive only explicitly marked demo races; keep all existing registrations and custom events.
for(const row of db.prepare('SELECT id,data FROM events').all()){const e=JSON.parse(row.data);if(e.sample===true&&!e.archived){e.archived=true;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(e),row.id)}}
for(const e of seedEvents)db.prepare('INSERT OR IGNORE INTO events(id,data) VALUES (?,?)').run(e.id,JSON.stringify(e));
// Apply the organizer's registration revision once, without recreating any records.
{const seed=seedEvents.find(e=>e.id==='arraba-2026'),row=db.prepare('SELECT data FROM events WHERE id=?').get('arraba-2026');if(seed&&row){const current=JSON.parse(row.data);if((current.registrationRevision||0)<2){for(const key of ['name','label','organizer','location','start','timePending','description','translations','registrationRevision'])current[key]=seed[key];db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(current),current.id)}}}
// Organizer content update: preserve uploaded logos, custom sponsors and existing registrations.
{const seed=seedEvents.find(e=>e.id==='arraba-2026'),row=db.prepare('SELECT data FROM events WHERE id=?').get('arraba-2026');if(seed&&row){const current=JSON.parse(row.data);if((current.contentRevision||0)<3){current.description=seed.description;current.translations=seed.translations;current.contentRevision=3;const sponsors=current.sponsors||[];for(const s of seed.sponsors||[])if(!sponsors.some(v=>v.name===s.name))sponsors.push(s);current.sponsors=sponsors;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(current),current.id)}}}
// Install the six supplied sponsor logos once in the organizer's requested order.
{const seed=seedEvents.find(e=>e.id==='arraba-2026'),row=db.prepare('SELECT data FROM events WHERE id=?').get('arraba-2026');if(seed&&row){const current=JSON.parse(row.data);if((current.sponsorRevision||0)<4){const replaced=new Set([...seed.sponsors.map(s=>s.name),'بلدية عرابة — قسم الصحة والرياضة والثقافة']);current.sponsors=[...seed.sponsors,...(current.sponsors||[]).filter(s=>!replaced.has(s.name))];current.sponsorRevision=4;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(current),current.id)}}}
// Apply organizer notes dated 20 October once; preserve registrations and sponsors.
{const seed=seedEvents.find(e=>e.id==='arraba-2026'),row=db.prepare('SELECT data FROM events WHERE id=?').get('arraba-2026');if(seed&&row){const current=JSON.parse(row.data);if((current.oct20Revision||0)<1){for(const key of ['description','translations','images','label'])current[key]=seed[key];current.oct20Revision=1;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(current),current.id)}}}
function adminEvents(){const counts=new Map(db.prepare('SELECT event_id,COUNT(*) AS total FROM registrations WHERE cancelled=0 GROUP BY event_id').all().map(r=>[r.event_id,r.total]));return getEvents().map(e=>({...e,registeredCount:counts.get(e.id)||0}));}
function getEvents(){return db.prepare('SELECT data FROM events').all().map(r=>JSON.parse(r.data)).filter(e=>!e.archived).sort((a,b)=>new Date(a.start)-new Date(b.start));}
function getEvent(id){const row=db.prepare('SELECT data FROM events WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
function validateEvent(b,id){
 const types={road:'جري على الطريق',trail:'جري في الطبيعة',family:'جري عائلي'};
 const name=String(b.name||'').trim(),location=String(b.location||'').trim(),description=String(b.description||'').trim();
 const date=new Date(b.start),distances=Array.isArray(b.distances)?[...new Set(b.distances.map(x=>String(x).trim()).filter(Boolean))]:[];
 if(name.length<2||name.length>100||location.length<2||location.length>200||description.length>2000||!Number.isFinite(date.getTime())||!types[b.type]||!distances.length||distances.length>10||distances.some(d=>d.length>30))return null;
 const old=getEvent(id);const ids=Array.isArray(b.imageIds)?b.imageIds:[];if(ids.length>6||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)return null;
 const images=[];for(const id of ids){const media=db.prepare('SELECT * FROM media WHERE id=?').get(id);if(!media)return null;images.push({id,url:'/uploads/'+id+'.'+media.extension})}
 const translations={};for(const language of ['he','en']){translations[language]={};for(const field of ['name','location','description']){const value=String(b.translations?.[language]?.[field]||'').trim();if(value.length>({name:100,location:200,description:2000}[field]))return null;translations[language][field]=value}}
 if(!images.length&&!ids.length&&old?.images?.some(i=>i.url.startsWith('assets/')))images.push(...old.images);
 if(old?.registrationProfile==='student')b.feeMinor=0;
 return {...features.config(b),registrationProfile:old?.registrationProfile||null,registrationRevision:old?.registrationRevision||0,contentRevision:old?.contentRevision||0,sponsorRevision:old?.sponsorRevision||0,oct20Revision:old?.oct20Revision||0,organizer:old?.organizer||null,eventDate:old?.eventDate||null,timePending:b.timePending===true,feesPending:b.feesPending===true,id,name,location,description,translations,images,start:date.toISOString(),distances,type:b.type,label:id==='arraba-2026'?'خطوة نحو الصحة':types[b.type],art:String(b.art||distances[0]).slice(0,12),sample:false};
}
function sameOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host;}catch{return false;}}
const loginLimit=new Map();
function allowLogin(req){const now=Date.now(),key=clientIP(req);let v=loginLimit.get(key);if(!v||v.until<now){v={count:0,until:now+15*60000};loginLimit.set(key,v)}return ++v.count<=10;}
const port=Number(process.env.PORT||3000);
const mailReady=()=>!!((process.env.BREVO_API_KEY||process.env.RESEND_API_KEY)&&process.env.EMAIL_FROM&&process.env.PUBLIC_URL);
function waConfig(language='ar'){const suffix=language==='ar'?'':'_'+language.toUpperCase();return {name:process.env['WHATSAPP_TEMPLATE'+suffix],code:process.env['WHATSAPP_TEMPLATE_LANGUAGE'+suffix]||(language==='en'?'en_US':language)};}
const waReady=(language='ar')=>!!(process.env.WHATSAPP_TOKEN&&process.env.WHATSAPP_PHONE_ID&&waConfig(language).name&&process.env.WHATSAPP_API_VERSION);
function json(res,status,body){if(body&&typeof body==='object'&&!Array.isArray(body)){body={...body};for(const key of ['error','message'])if(typeof body[key]==='string')body[key]=locale.translate(body[key],res.language||'ar')}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
async function readJSON(req){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536){const e=Error('الطلب أكبر من الحد المسموح');e.status=413;throw e}}try{const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}catch{const e=Error('بيانات غير صالحة');e.status=400;throw e}}
function clientIP(req){return process.env.TRUST_PROXY==='1'&&req.headers['x-real-ip']?String(req.headers['x-real-ip']).slice(0,64):req.socket.remoteAddress}
const limit=new Map();function allow(req){const now=Date.now(),key=clientIP(req);const item=limit.get(key);if(!item||item.until<now){limit.set(key,{count:1,until:now+60000});return true}return ++item.count<=300}
setInterval(()=>{for(const map of [limit,loginLimit])for(const [k,v]of map)if(v.until<Date.now())map.delete(k)},60000).unref();
const sms=require('./sms.cjs')({db,getEvent,locale});
const features=require('./features.cjs')({db,getEvent,getEvents,json,readJSON,allow,locale,sms,wakeEmail:()=>setImmediate(()=>reminders().catch(e=>console.error(e.message)))});
let activeUploads=0;
const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');const url=new URL(req.url,'http://localhost');res.language=locale.normalize((req.headers['accept-language']||'ar').split(',')[0].slice(0,2));
try{
if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{app:'khotwa',smsReady:sms.ready(),emailReady:mailReady(),messagingReady:mailReady()&&waReady(res.language),messagingByLanguage:Object.fromEntries(['ar','he','en'].map(l=>[l,mailReady()&&waReady(l)]))});
if(req.method==='GET'&&url.pathname==='/api/events')return json(res,200,getEvents().map(features.publicEvent));
if(await features.publicRoute(req,res,url))return;
if(req.method==='POST'&&url.pathname==='/api/registrations'){await features.register(req,res);return;}
if(url.pathname==='/api/auth/login'&&req.method==='POST'){
 if(!sameOrigin(req))return json(res,403,{error:'طلب دخول غير مسموح'});
 if(!allowLogin(req))return json(res,429,{error:'محاولات كثيرة. حاول بعد 15 دقيقة.'});
 if(!db.prepare('SELECT 1 FROM admins LIMIT 1').get())return json(res,503,{error:'أنشئ حساب المدير أولًا بالأمر npm run setup'});
 const b=await readJSON(req);const username=String(b.username||'').trim(),password=String(b.password||'');
 if(username.length>50||password.length>128)return json(res,400,{error:'بيانات الدخول غير صالحة'});
 const admin=db.prepare('SELECT * FROM admins WHERE username=?').get(username);
 const dummy='00000000000000000000000000000000:'+ '0'.repeat(128);
 const verified=await auth.verifyPassword(password,admin?.password_hash||dummy);
 if(!admin||!verified)return json(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
 const previous=auth.session(db,req);if(previous)db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(previous.token_hash);
 const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(32).toString('hex');
 db.prepare('INSERT INTO admin_sessions (token_hash,username,csrf,expires) VALUES (?,?,?,?)').run(auth.tokenHash(token),username,csrf,Date.now()+8*3600000);
 db.prepare('DELETE FROM admin_sessions WHERE expires<=?').run(Date.now());
 res.setHeader('Set-Cookie',auth.cookie(token,8*3600));return json(res,200,{username,csrf});
}
if(url.pathname==='/api/auth/me'&&req.method==='GET'){const user=auth.session(db,req);return user?json(res,200,{username:user.username,csrf:user.csrf}):json(res,401,{error:'يرجى تسجيل الدخول'});}
if(url.pathname.startsWith('/api/admin/')||url.pathname==='/api/auth/logout'){
 const user=auth.session(db,req);if(!user)return json(res,401,{error:'انتهت الجلسة. يرجى تسجيل الدخول.'});
 if(!['GET','HEAD'].includes(req.method)&&(!sameOrigin(req)||req.headers['x-csrf-token']!==user.csrf))return json(res,403,{error:'الطلب غير مسموح. حدّث الصفحة وحاول مجددًا.'});
 if(await features.admin(req,res,url))return;
 if(url.pathname==='/api/auth/logout'&&req.method==='POST'){db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(user.token_hash);res.setHeader('Set-Cookie',auth.cookie('',0));return json(res,200,{ok:true});}
 if(req.method==='GET'&&url.pathname==='/api/admin/registrations'){
  const page=Math.min(1000000,Math.max(1,parseInt(url.searchParams.get('page'))||1)),pageSize=50,q=(url.searchParams.get('q')||'').trim().slice(0,100),eventId=url.searchParams.get('eventId')||'';
  let where='cancelled=0';const params=[];if(eventId){where+=' AND event_id=?';params.push(eventId)}if(q){where+=' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';params.push('%'+q+'%','%'+q+'%','%'+q+'%')}
  const total=db.prepare('SELECT COUNT(*) AS total FROM registrations WHERE '+where).get(...params).total;
  let items=db.prepare('SELECT id,event_id,name,email,phone,distance,created_at,bib,state,age,group_name,checked_in_at,payment_state,refund_due,student_json,(SELECT status FROM sms_jobs j WHERE j.registration_id=registrations.id AND j.kind=\'confirmation\') AS sms_confirmation,(SELECT status FROM sms_jobs j WHERE j.registration_id=registrations.id AND j.kind=\'reminder\') AS sms_reminder FROM registrations WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...params,pageSize,(page-1)*pageSize);
  items=items.map(r=>{const {student_json,...base}=r;return {...base,email:r.email.endsWith('@participant.invalid')?'':r.email,student:student_json?JSON.parse(student_json):null}});
  return json(res,200,{items,total,page,pageSize,pages:Math.max(1,Math.ceil(total/pageSize)),totalActive:db.prepare('SELECT COUNT(*) AS total FROM registrations WHERE cancelled=0').get().total});
 }
 if(req.method==='POST'&&url.pathname==='/api/admin/uploads'){
  if(activeUploads>=2)return json(res,429,{error:'رفع الصور مشغول. حاول بعد قليل.'});activeUploads++;try{
 const buffer=await readImage(req),type=imageType(buffer);if(!type)return json(res,400,{error:'الصورة غير صالحة. اختر JPG أو PNG أو WebP.'});
  const id=crypto.randomUUID(),file=path.join(uploadDir,id+'.'+type.extension);
  await fs.promises.writeFile(file,buffer,{flag:'wx'});
  try{db.prepare('INSERT INTO media (id,extension,mime,size,created_at) VALUES (?,?,?,?,?)').run(id,type.extension,type.mime,buffer.length,new Date().toISOString())}catch(e){await fs.promises.unlink(file);throw e}
  return json(res,201,{id,url:'/uploads/'+id+'.'+type.extension});
 }finally{activeUploads--}
 }
 if(req.method==='GET'&&url.pathname==='/api/admin/events')return json(res,200,adminEvents());
 if(req.method==='POST'&&url.pathname==='/api/admin/events'){
  const b=await readJSON(req),event=validateEvent(b,crypto.randomUUID());if(!event)return json(res,400,{error:'راجع اسم السباق والمكان والتاريخ والمسافات'});
  db.prepare('INSERT INTO events (id,data) VALUES (?,?)').run(event.id,JSON.stringify(event));return json(res,201,event);
 }
 const match=url.pathname.match(/^\/api\/admin\/events\/([a-zA-Z0-9-]+)$/);
 if(match&&req.method==='PUT'){
  const old=getEvent(match[1]);if(!old)return json(res,404,{error:'السباق غير موجود'});
  const b=await readJSON(req);for(const key of ['feeMinor','capacities','waitlistEnabled','route','sponsors','albumIds'])if(b[key]===undefined)b[key]=key==='albumIds'?(old.album||[]).map(i=>i.id):old[key];if(!Array.isArray(b.imageIds))b.imageIds=(old.images||[]).map(i=>i.id);const event=validateEvent(b,match[1]);if(!event)return json(res,400,{error:'راجع بيانات السباق'});
  if(db.prepare("SELECT 1 FROM notifications n JOIN registrations r ON r.id=n.registration_id WHERE r.event_id=? AND n.status='sent' LIMIT 1").get(event.id)&&event.start!==old.start)return json(res,409,{error:'تم إرسال تذكيرات لهذا السباق؛ تغيير الموعد يحتاج إشعارًا جديدًا للمشاركين.'});
  const used=db.prepare('SELECT DISTINCT distance FROM registrations WHERE event_id=? AND cancelled=0').all(event.id);if(used.some(x=>!event.distances.includes(x.distance)))return json(res,409,{error:'لا يمكن إزالة مسافة مسجّل فيها مشاركون'});
  for(const [distance,capacity] of Object.entries(event.capacities||{})){const used=db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id=? AND distance=? AND cancelled=0 AND state IN ('confirmed','pending_payment')").get(event.id,distance).n;if(used>capacity)return json(res,409,{error:'السعة أقل من المشاركات المحجوزة.'});}
  db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(event),event.id);features.promote(event.id);return json(res,200,event);
 }
 return json(res,404,{error:'المسار غير موجود'});
}
if(req.method==='GET'&&url.pathname==='/cancel'){
 const token=url.searchParams.get('token')||'',language=locale.normalize(url.searchParams.get('lang')),t=text=>locale.translate(text,language),valid=/^[a-f0-9]{64}$/.test(token);
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 return res.end(`<html lang="${language}" dir="${language==='en'?'ltr':'rtl'}"><meta charset="utf-8"><title>${esc(t('إلغاء المشاركة'))}</title><h1>${esc(t('إلغاء المشاركة والتذكيرات'))}</h1><form method="POST" action="/cancel"><input type="hidden" name="token" value="${valid?token:''}"><input type="hidden" name="language" value="${language}"><button>${esc(t('تأكيد إلغاء المشاركة'))}</button></form></html>`);
}
if(req.method==='POST'&&url.pathname==='/cancel'){
 let body='';for await(const c of req){body+=c;if(body.length>1024)return json(res,413,{error:'طلب غير صالح'})}
 const params=new URLSearchParams(body),token=params.get('token');res.language=locale.normalize(params.get('language'));
 if(!token||!/^[a-f0-9]{64}$/.test(token))return json(res,400,{error:'رابط غير صالح'});
 return json(res,200,features.cancel(token));
}
if(url.pathname.startsWith('/api/'))return json(res,404,{error:'المسار غير موجود'});
if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'الطريقة غير مسموحة'});
if(url.pathname.startsWith('/uploads/')){
 const match=url.pathname.match(/^\/uploads\/([a-f0-9-]{36})\.(jpg|png|webp)$/);if(!match)return json(res,404,{error:'الملف غير موجود'});
 const media=db.prepare('SELECT * FROM media WHERE id=? AND extension=?').get(match[1],match[2]);if(!media)return json(res,404,{error:'الملف غير موجود'});
 const file=path.join(uploadDir,media.id+'.'+media.extension);try{await fs.promises.access(file)}catch{return json(res,404,{error:'الملف غير موجود'})}
 res.writeHead(200,{'Content-Type':media.mime,'Content-Length':media.size,'Cache-Control':'public,max-age=31536000,immutable','Content-Security-Policy':"default-src 'none'; sandbox"});if(req.method==='HEAD')return res.end();await pipeline(fs.createReadStream(file),res);return;
}
let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{return json(res,400,{error:'مسار غير صالح'})}const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep))return json(res,403,{error:'غير مسموح'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'الملف غير موجود'});const types={'.mp4':'video/mp4','.jpeg':'image/jpeg','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
}catch(e){console.error('Request failed:',e.message);if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'تعذّر إكمال الطلب. حاول لاحقًا.'})}});
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function send(row,event){
 const language=locale.normalize(row.language);event=locale.eventView(event,language,seedEvents);const t=text=>locale.translate(text,language);
 const date=new Date(event.start).toLocaleString(language,{timeZone:'Asia/Jerusalem'});
 const participantLink=process.env.PUBLIC_URL?.replace(/\/$/,'')+'/participant.html#token='+row.cancel_token;
 const cancel=process.env.PUBLIC_URL?.replace(/\/$/,'')+'/cancel?lang='+language+'&token='+row.cancel_token;
 let endpoint,headers,body;
 if(row.channel.startsWith('email')){if(!mailReady())return false;endpoint='https://api.resend.com/emails';headers={Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':row.id+'-reminder'};body={from:process.env.EMAIL_FROM,to:[row.email],subject:t('تذكير بموعد')+' '+event.name,html:`<div dir="${language==='en'?'ltr':'rtl'}" lang="${language}"><h2>${esc(t('مرحبًا'))} ${esc(row.name)}</h2><p>${esc(t('نذكّرك بموعد'))} ${esc(event.name)}: ${esc(date)}.</p><p>${esc(t('المكان'))}: ${esc(event.location)}. ${esc(t('المسافة'))}: ${esc(locale.distance(row.distance,language))}.</p><p>${esc(t('يرجى الحضور قبل الانطلاق بنصف ساعة.'))}</p><a href="${esc(cancel)}">${esc(t('إلغاء المشاركة والتذكيرات'))}</a><p><a href="${esc(participantLink)}">${esc(t('صفحتي وبطاقة المشاركة'))}</a></p></div>`}
 if(row.channel==='email_confirmation'){
 const subjects={ar:'تأكيد التسجيل',he:'אישור הרשמה',en:'Registration confirmation'};
 body.subject=subjects[language]+' — '+event.name;
 body.html=`<div dir="${language==='en'?'ltr':'rtl'}"><h2>${esc(body.subject)}</h2><p>${esc(row.name)}</p><p>${esc(event.name)} — ${esc(event.eventDate||date)}</p><p>${esc(t('رقم المشارك'))}: ${esc(row.bib)}</p><p>${esc(t(row.state))}</p><a href="${esc(participantLink)}">${esc(t('صفحتي وبطاقة المشاركة'))}</a></div>`;
 headers['Idempotency-Key']=row.id+'-confirmation';
 }
 if(process.env.BREVO_API_KEY){
 const match=process.env.EMAIL_FROM.match(/^(.*?)\s*<([^>]+)>$/);
 endpoint='https://api.brevo.com/v3/smtp/email';
 headers={'api-key':process.env.BREVO_API_KEY,'Content-Type':'application/json'};
 body={sender:{name:match?match[1].trim():'Run Msafat',email:match?match[2]:process.env.EMAIL_FROM},to:[{email:row.email,name:row.name}],subject:body.subject,htmlContent:body.html};
 }
 }
 else{if(!waReady(language))return false;endpoint=`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`;headers={Authorization:'Bearer '+process.env.WHATSAPP_TOKEN,'Content-Type':'application/json'};body={messaging_product:'whatsapp',to:row.phone.replace('+',''),type:'template',template:{name:waConfig(language).name,language:{code:waConfig(language).code},components:[{type:'body',parameters:[row.name,event.name,date,event.location,locale.distance(row.distance,language)].map(text=>({type:'text',text}))}]}}}
 const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok){const e=Error('Provider HTTP '+response.status);e.retry=response.status===429||response.status>=500;throw e}return true;
}
let working=false;
async function reminders(){if(working)return;working=true;try{
 const now=new Date().toISOString(),until=new Date(Date.now()+24*3600000).toISOString();
 db.prepare("UPDATE notifications SET status='expired' WHERE status='pending' AND registration_id IN (SELECT r.id FROM registrations r JOIN events e ON e.id=r.event_id WHERE unixepoch(json_extract(e.data,'$.start'))<=unixepoch(?))").run(now);
 const langs=['ar','he','en'].filter(waReady);let delivery=mailReady()?"n.channel IN ('email','email_confirmation')":"0";if(langs.length)delivery+=" OR (n.channel='whatsapp' AND r.language IN ("+langs.map(()=>'?').join(',')+"))";
 const rows=db.prepare("SELECT r.*,n.channel,n.attempts FROM notifications n JOIN registrations r ON n.registration_id=r.id JOIN events e ON e.id=r.event_id WHERE r.cancelled=0 AND r.state='confirmed' AND n.status='pending' AND (n.next_attempt IS NULL OR n.next_attempt<=?) AND unixepoch(json_extract(e.data,'$.start'))>unixepoch(?) AND (n.channel='email_confirmation' OR unixepoch(json_extract(e.data,'$.start'))<=unixepoch(?)) AND ("+delivery+") ORDER BY unixepoch(json_extract(e.data,'$.start')),r.created_at LIMIT 200").all(now,now,until,...langs);
 let cursor=0;async function worker(){while(cursor<rows.length){const row=rows[cursor++];if(db.prepare('SELECT cancelled FROM registrations WHERE id=?').get(row.id)?.cancelled)continue;const event=getEvent(row.event_id);if(!event||event.archived||(event.timePending&&row.channel!=='email_confirmation')||new Date(event.start)<=new Date())continue;
 try{if(await send(row,event))db.prepare("UPDATE notifications SET status='sent',sent_at=?,last_error=NULL WHERE registration_id=? AND channel=?").run(new Date().toISOString(),row.id,row.channel)}catch(e){const attempts=row.attempts+1,retry=e.retry===true;db.prepare('UPDATE notifications SET attempts=?,status=?,next_attempt=?,last_error=? WHERE registration_id=? AND channel=?').run(attempts,retry&&attempts<5?'pending':'failed',new Date(Date.now()+Math.min(3600000,60000*2**attempts)).toISOString(),e.message,row.id,row.channel);console.error('Reminder delivery failed:',row.channel,e.message)}}}
 await Promise.all(Array.from({length:Math.min(4,rows.length)},worker));
 }finally{working=false}}
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(port,()=>{console.log('Run Msafat: http://localhost:'+port);sms.wake();reminders().catch(e=>console.error(e.message));});setInterval(()=>reminders().catch(e=>console.error(e.message)),60000).unref();

setInterval(()=>sms.wake(),60000).unref();
