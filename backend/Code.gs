/**
 * Mandarin 1的知识群岛 — 登入与进度后台 (Google Apps Script, bound to a Google Sheet)
 *
 * 部署方法见 backend/部署说明.md。Setup guide: backend/部署说明.md
 *
 * Students sign up with: class code + Student ID + nickname + 4-digit PIN, and log in with class code + Student ID + PIN.
 * Each class can have a list of valid Student IDs: sign-ups with an ID not on the list are refused,
 * and records whose ID is not on the list can be removed (dashboard button or sheet menu).
 * The teacher dashboard (teacher.html) signs in with the teacher password set from the sheet's menu.
 * PINs are stored only as salted SHA-256 hashes.
 */

const SH_CLASSES = '班级 Classes';
const SH_STUDENTS = '学生 Students';
const ISLANDS = ['C1','C2','C3','C4','C5','C6','C7','C8','C9'];   // one island = one Chapter
const CLASS_HEADERS = ['代码 Code','名称 Name','开放 Active','建立 Created','学号名单 Student IDs','岛屿设置 Islands'];
const STUDENT_HEADERS = ['班级 Class','学号 Student ID','昵称 Nickname','salt','pinHash','建立 Created','最后登入 Last login','token','tokenExp','fails','lockUntil',
  '最后更新 Updated','总进度 Overall %','完成岛 Islands done','星星 Stars','椰子币 Coins'].concat(ISLANDS).concat(['summary','state']);
const COL = { cls:0, sid:1, nick:2, salt:3, hash:4, created:5, last:6, token:7, exp:8, fails:9, lock:10, updated:11, pct:12, done:13, stars:14, coins:15, isl:16, summary:25, state:26 };
const TOKEN_DAYS = 90, MAX_FAILS = 5, LOCK_MIN = 10, MAX_STATE = 45000;

/* ---------------- sheet menu (teacher) ---------------- */
function onOpen(){
  SpreadsheetApp.getUi().createMenu('知识群岛')
    .addItem('1. 初始化表格 Set up sheets', 'setupSheets')
    .addItem('2. 设定老师密码 Set teacher password', 'setTeacherPassword')
    .addItem('3. 建立班级代码 Create a class code', 'createClassFromMenu')
    .addItem('4. 删除学号不在名单的记录 Remove students not on the ID list', 'purgeFromMenu')
    .addToUi();
}
function setupSheets(){
  classSheet_(); students_();
  try{ SpreadsheetApp.getUi().alert('表格已准备好。\n在「班级 Classes」分页 E 栏可以贴上每班的学号名单（用逗号或换行分开），也可以在老师后台设定。\nSheets are ready. You can paste each class\'s Student IDs in column E of the Classes tab, or set them in the teacher dashboard.'); }catch(e){}
}
function setTeacherPassword(){
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('设定老师密码 Teacher password', '至少 8 个字符。老师后台用这个密码登入。\nAt least 8 characters. Used to open the teacher dashboard.', ui.ButtonSet.OK_CANCEL);
  if(r.getSelectedButton() !== ui.Button.OK) return;
  const pw = r.getResponseText().trim(); if(pw.length < 8){ ui.alert('密码太短，至少 8 个字符。Too short.'); return; }
  const salt = Utilities.getUuid(); const p = PropertiesService.getScriptProperties();
  p.setProperty('TEACHER_SALT', salt); p.setProperty('TEACHER_HASH', sha(salt + pw)); ui.alert('老师密码已设定。Teacher password saved.');
}
function createClassFromMenu(){
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('建立班级代码 New class code', '例如 MANDARIN1A（3–12 个英文字母或数字）\ne.g. MANDARIN1A (3–12 letters or digits)', ui.ButtonSet.OK_CANCEL);
  if(r.getSelectedButton() !== ui.Button.OK) return;
  const res = createClass_(r.getResponseText(), '');
  ui.alert(res.ok ? ('班级代码已建立：' + res.code) : ('无法建立：' + res.error));
}
function purgeFromMenu(){
  const ui = SpreadsheetApp.getUi(); let total = 0; const lines = [];
  classSheet_().getDataRange().getValues().slice(1).forEach(c=>{ if(!c[0]) return; const r = purge_(c[0], true); if(r.ok){ total += r.removed; lines.push(`${c[0]}: ${r.removed}`); } else if(r.error==='no_list'){ lines.push(`${c[0]}: 没有名单，跳过 no ID list, skipped`); } });
  ui.alert(`已删除 ${total} 条学号不在名单的记录。Removed ${total} record(s).\n\n` + lines.join('\n'));
}

/* ---------------- web API ---------------- */
function doGet(){ return json({ok:true, service:'mandarin1-isles', version:5, time:new Date().toISOString()}); }
function doPost(e){
  let req; try{ req = JSON.parse(e.postData.contents || '{}'); }catch(err){ return json({ok:false, error:'bad_json'}); }
  // saving, loading, the island settings and the leaderboard only touch the student's own row (or read), so they do not queue behind the global lock:
  // with 60+ students playing at once, a single lock for everything makes requests time out. Sign-up, login, log-out and teacher actions keep the lock.
  if(req.action==='save' || req.action==='load' || req.action==='cfg' || req.action==='board' || req.action==='feedback' || req.action==='errlog'){
    try{ return json(route_(req)); }
    catch(err){ return json({ok:false, error:'server', detail:String(err && err.message || err)}); }
  }
  const lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(err){ return json({ok:false, error:'busy'}); }
  try{ return json(route_(req)); }
  catch(err){ return json({ok:false, error:'server', detail:String(err && err.message || err)}); }
  finally{ lock.releaseLock(); }
}
function route_(r){
  switch(r.action){
    case 'register': return register_(r);
    case 'login':    return login_(r);
    case 'load':     return load_(r);
    case 'save':     return save_(r);
    case 'logout':   return logout_(r);
    case 'board':    return board_(r);
    case 'feedback': return feedback_(r);
    case 'errlog':   return errlog_(r);
    case 'cfg':      { const a = auth_(r.token); if(!a) return {ok:false, error:'auth'}; return {ok:true, islands:islandsOf_(a.values[COL.cls])}; }
    case 'tLogin':   return teacher_(r, ()=>({ok:true}));
    case 'tClasses': return teacher_(r, ()=>({ok:true, classes:classes_()}));
    case 'tCreateClass': return teacher_(r, ()=>createClass_(r.code, r.name));
    case 'tToggleClass': return teacher_(r, ()=>toggleClass_(r.code, r.active));
    case 'tSetList': return teacher_(r, ()=>setList_(r.code, r.ids));
    case 'tPurge':   return teacher_(r, ()=>purge_(r.cls));
    case 'tSetIslands': return teacher_(r, ()=>setIslands_(r.code, r.islands));
    case 'tRoster':  return teacher_(r, ()=>roster_(r.cls));
    case 'tLogs':    return teacher_(r, ()=>logsList_());
    case 'tFeedback': return teacher_(r, ()=>feedbackList_(r.cls, !!r.all));
    case 'tFeedbackDone': return teacher_(r, ()=>feedbackDone_(r.id, r.done!==false));
    case 'tResetPin': return teacher_(r, ()=>resetPin_(r.cls, r.sid, r.pin));
    case 'tDelete':  return teacher_(r, ()=>deleteStudent_(r.cls, r.sid));
    default: return {ok:false, error:'unknown_action'};
  }
}

/* ---------------- students ---------------- */
function register_(r){
  const cls = normCode_(r.cls), sid = normSid_(r.sid), nick = normNick_(r.nick), pin = String(r.pin||'');
  if(!cls) return {ok:false, error:'bad_class'}; if(!sid) return {ok:false, error:'bad_sid'}; if(!nick) return {ok:false, error:'bad_nick'}; if(!/^\d{4}$/.test(pin)) return {ok:false, error:'bad_pin'};
  const k = findClass_(cls); if(!k) return {ok:false, error:'no_class'}; if(!k.active) return {ok:false, error:'class_closed'};
  if(k.ids.length && k.ids.indexOf(sid) < 0) return {ok:false, error:'not_on_list'};
  const sh = students_(); if(findStudent_(sh, cls, sid)) return {ok:false, error:'sid_taken'};
  const salt = Utilities.getUuid(), now = new Date(), token = Utilities.getUuid();
  const row = new Array(STUDENT_HEADERS.length).fill('');
  row[COL.cls]=cls; row[COL.sid]=sid; row[COL.nick]=nick; row[COL.salt]=salt; row[COL.hash]=sha(salt+pin); row[COL.created]=now; row[COL.last]=now;
  row[COL.token]=token; row[COL.exp]=new Date(now.getTime()+TOKEN_DAYS*864e5); row[COL.fails]=0; row[COL.lock]=''; row[COL.updated]=now; row[COL.state]='';
  sh.appendRow(row); sh.getRange(sh.getLastRow(), COL.sid+1).setNumberFormat('@').setValue(sid);
  cacheRow_(token, sh.getLastRow());
  return {ok:true, token, cls, sid, nick, state:null, updated:0, islands:islandsOf_(cls)};
}
function login_(r){
  const cls = normCode_(r.cls), sid = normSid_(r.sid), pin = String(r.pin||'');
  if(!cls || !sid || !/^\d{4}$/.test(pin)) return {ok:false, error:'bad_input'};
  const sh = students_(), f = findStudent_(sh, cls, sid); if(!f) return {ok:false, error:'no_student'};
  const v = f.values, now = new Date();
  if(v[COL.lock] && new Date(v[COL.lock]) > now) return {ok:false, error:'locked', until:new Date(v[COL.lock]).toISOString()};
  if(sha(v[COL.salt]+pin) !== v[COL.hash]){
    const fails = Number(v[COL.fails]||0)+1; sh.getRange(f.row, COL.fails+1).setValue(fails);
    if(fails >= MAX_FAILS){ sh.getRange(f.row, COL.lock+1).setValue(new Date(now.getTime()+LOCK_MIN*6e4)); sh.getRange(f.row, COL.fails+1).setValue(0); return {ok:false, error:'locked', minutes:LOCK_MIN}; }
    return {ok:false, error:'wrong_pin', left:MAX_FAILS-fails};
  }
  // keep an existing session so the student stays signed in on their other devices
  const token = (v[COL.token] && v[COL.exp] && new Date(v[COL.exp]) > now) ? v[COL.token] : Utilities.getUuid();
  sh.getRange(f.row, COL.last+1, 1, 5).setValues([[now, token, new Date(now.getTime()+TOKEN_DAYS*864e5), 0, '']]);
  cacheRow_(token, f.row);
  return {ok:true, token, cls:v[COL.cls], sid:String(v[COL.sid]), nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated]), islands:islandsOf_(v[COL.cls])};
}
/* ---------------- automatic error and performance logs (sent by the game itself) ---------------- */
const SH_LOGS = '日志 Logs';
const LOG_HEADERS = ['时间 Time','类型 Kind','班级 Class','学号 Student ID','信息 Message','位置 Where','详情 Detail','设备 Device'];
const LOG_PER_USER_DAY = 30, LOG_ANON_DAY = 150, LOG_KEEP_ROWS = 3000;
function logsSheet_(){ const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName(SH_LOGS);
  if(!sh){ sh = ss.insertSheet(SH_LOGS); sh.appendRow(LOG_HEADERS); sh.setFrozenRows(1); sh.getRange('D:D').setNumberFormat('@'); }
  return sh; }
function errlog_(r){
  const a = r.token ? auth_(r.token) : null, cls = a ? a.values[COL.cls] : '', sid = a ? normSid_(a.values[COL.sid]) : '';
  const kind = ['error','promise','resource','webgl','quality','perf'].indexOf(r.kind) >= 0 ? r.kind : 'error';
  const cache = CacheService.getScriptCache(), day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const ck = 'lg:' + (a ? cls + ':' + sid : 'anon') + ':' + day, cap = a ? LOG_PER_USER_DAY : LOG_ANON_DAY, n = Number(cache.get(ck)||0);
  if(n >= cap) return {ok:false, error:'too_many'};
  const msg = cleanText_(r.msg, 200); if(!msg) return {ok:false, error:'empty'};
  // the same message from the same student is stored only once an hour (perf reports once a day)
  const sig = 'ls:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, kind + '|' + (sid||'anon') + '|' + msg)).slice(0, 40);
  if(cache.get(sig)) return {ok:true, dup:true};
  const lock = LockService.getScriptLock(); try{ lock.waitLock(5000); }catch(e){ return {ok:false, error:'busy'}; }
  try{ const sh = logsSheet_(); sh.appendRow([new Date(), kind, cls, sid, msg, cleanText_(r.where, 60), cleanText_(r.detail, 600), cleanText_(r.dev, 200)]);
    const rows = sh.getLastRow(); if(rows > LOG_KEEP_ROWS + 200) sh.deleteRows(2, rows - LOG_KEEP_ROWS); } finally { lock.releaseLock(); }
  try{ cache.put(ck, String(n+1), 86400); cache.put(sig, '1', kind==='perf' ? 21600 : 3600); }catch(e){}
  return {ok:true};
}
function logsList_(){
  const sh = logsSheet_(), n = sh.getLastRow(); if(n < 2) return {ok:true, items:[]};
  const from = Math.max(2, n-599), v = sh.getRange(from, 1, n-from+1, LOG_HEADERS.length).getValues();
  return {ok:true, items:v.reverse().map(x=>({t:x[0] instanceof Date ? x[0].toISOString() : String(x[0]), kind:x[1], cls:x[2], sid:String(x[3]), msg:x[4], where:x[5], detail:x[6], dev:x[7]}))};
}

/* ---------------- student feedback: wrong answers, typos, bugs ---------------- */
const SH_FEEDBACK = '反馈 Feedback';
const FB_HEADERS = ['id','时间 Time','班级 Class','学号 Student ID','昵称 Nickname','类型 Type','位置 Where','题目 Question','显示的答案 Shown answer','学生留言 Comment','设备 Device','状态 Status','处理时间 Done at'];
const FB_MAX_PER_DAY = 15;
function feedbackSheet_(){ const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName(SH_FEEDBACK);
  if(!sh){ sh = ss.insertSheet(SH_FEEDBACK); sh.appendRow(FB_HEADERS); sh.setFrozenRows(1); sh.getRange('D:D').setNumberFormat('@'); sh.hideColumns(1); }
  return sh; }
// text from students goes into a sheet: control characters out, and a leading = + - @ is neutralised so it can never be read as a formula
function cleanText_(v, n){ let t = String(v==null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); if(/^[=+\-@]/.test(t)) t = "'" + t; return t; }
function feedback_(r){
  const a = auth_(r.token); if(!a) return {ok:false, error:'auth'};
  const cls = a.values[COL.cls], sid = normSid_(a.values[COL.sid]), nick = a.values[COL.nick];
  const cache = CacheService.getScriptCache(), ck = 'fb:'+cls+':'+sid+':'+Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const n = Number(cache.get(ck)||0); if(n >= FB_MAX_PER_DAY) return {ok:false, error:'too_many'};
  const msg = cleanText_(r.msg, 500), q = cleanText_(r.q, 300); if(!msg && !q) return {ok:false, error:'empty'};
  const type = ['answer','typo','bug','idea'].indexOf(r.type) >= 0 ? r.type : 'idea';
  const row = [Utilities.getUuid(), new Date(), cls, sid, cleanText_(nick, 40), type, cleanText_(r.where, 60), q, cleanText_(r.ans, 200), msg, cleanText_(r.dev, 160), 'new', ''];
  const lock = LockService.getScriptLock(); try{ lock.waitLock(8000); }catch(e){ return {ok:false, error:'busy'}; }
  try{ const sh = feedbackSheet_(); sh.appendRow(row); sh.getRange(sh.getLastRow(), 4).setNumberFormat('@').setValue(sid); } finally { lock.releaseLock(); }
  try{ cache.put(ck, String(n+1), 86400); }catch(e){}
  return {ok:true};
}
function feedbackList_(cls, all){
  const sh = feedbackSheet_(), n = sh.getLastRow(); if(n < 2) return {ok:true, items:[], open:0};
  const from = Math.max(2, n-499), v = sh.getRange(from, 1, n-from+1, FB_HEADERS.length).getValues(), want = cls ? normCode_(cls) : '';
  const items = []; let open = 0;
  v.forEach(x=>{ if(want && x[2]!==want) return; const done = x[11]==='done'; if(!done) open++; if(!all && done) return;
    items.push({id:x[0], t:x[1] instanceof Date ? x[1].toISOString() : String(x[1]), cls:x[2], sid:String(x[3]), nick:x[4], type:x[5], where:x[6], q:x[7], ans:x[8], msg:x[9], dev:x[10], done}); });
  items.reverse();
  return {ok:true, items, open};
}
function feedbackDone_(id, done){
  const sh = feedbackSheet_(), n = sh.getLastRow(); if(n < 2) return {ok:false, error:'not_found'};
  const ids = sh.getRange(2, 1, n-1, 1).getValues();
  for(let i=0;i<ids.length;i++) if(ids[i][0]===id){ sh.getRange(i+2, 12, 1, 2).setValues([[done ? 'done' : 'new', done ? new Date() : '']]); return {ok:true}; }
  return {ok:false, error:'not_found'};
}

/* ---------------- class leaderboard (nicknames only) ---------------- */
function board_(r){
  const a = auth_(r.token); if(!a) return {ok:false, error:'auth'};
  const cls = a.values[COL.cls], sid = normSid_(a.values[COL.sid]);
  const cache = CacheService.getScriptCache(), key = 'b:'+cls; let rows = null;
  try{ const hit = cache.get(key); if(hit) rows = JSON.parse(hit); }catch(e){}
  if(!rows){
    const sh = students_(), n = sh.getLastRow(); rows = [];
    if(n > 1) sh.getRange(2, 1, n-1, COL.stars+1).getValues().forEach(x=>{ if(x[COL.cls]===cls && x[COL.nick]) rows.push({i:normSid_(x[COL.sid]), n:String(x[COL.nick]), s:Number(x[COL.stars]||0), p:Number(x[COL.pct]||0)}); });
    rows.sort((p,q)=> q.s-p.s || q.p-p.p || (p.n<q.n?-1:1));
    let rank = 0, prev = null; rows.forEach((x,k)=>{ if(!prev || x.s!==prev.s || x.p!==prev.p) rank = k+1; x.r = rank; prev = x; });
    try{ cache.put(key, JSON.stringify(rows), 60); }catch(e){}
  }
  const me = rows.filter(x=>x.i===sid)[0] || null;
  return {ok:true, total:rows.length, top:rows.filter(x=>x.s>0).slice(0,10).map(x=>({r:x.r, n:x.n, s:x.s, p:x.p, me:x.i===sid})), me: me ? {r:me.r, n:me.n, s:me.s, p:me.p} : null};
}
function load_(r){ const a = auth_(r.token, true); if(!a) return {ok:false, error:'auth'}; const v=a.values; return {ok:true, cls:v[COL.cls], sid:String(v[COL.sid]), nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated]), islands:islandsOf_(v[COL.cls])}; }
function save_(r){
  const a = auth_(r.token); if(!a) return {ok:false, error:'auth'};
  const st = JSON.stringify(r.state||{}); if(st.length > MAX_STATE) return {ok:false, error:'too_big'};
  const s = r.summary || {}, now = new Date(), isl = ISLANDS.map((_,i)=>{ const x=(s.islands||[])[i]||{}; return x.locked ? '🔒' : `★${x.s||0} ${x.best!=null?x.best+'/'+(x.n||10):'—'} · ${x.games||0}/7 · ${x.pct||0}%`; });
  const vals = [now, Number(s.pct||0), Number(s.done||0), Number(s.stars||0), Number(s.coins||0)].concat(isl).concat([JSON.stringify(s), st]);
  a.sheet.getRange(a.row, COL.updated+1, 1, vals.length).setValues([vals]);
  return {ok:true, updated:now.getTime()};
}
function logout_(r){ const a = auth_(r.token); if(a){ a.sheet.getRange(a.row, COL.token+1, 1, 2).setValues([['','']]); try{ CacheService.getScriptCache().remove('r:'+r.token); }catch(e){} } return {ok:true}; }

/* ---------------- teacher ---------------- */
function teacher_(r, fn){
  const p = PropertiesService.getScriptProperties(), salt = p.getProperty('TEACHER_SALT'), hash = p.getProperty('TEACHER_HASH');
  if(!salt || !hash) return {ok:false, error:'no_teacher_password'};
  const until = Number(p.getProperty('T_LOCK')||0); if(until > Date.now()) return {ok:false, error:'locked'};
  if(sha(salt + String(r.key||'')) !== hash){ const n=Number(p.getProperty('T_FAILS')||0)+1; p.setProperty('T_FAILS', String(n)); if(n>=8){ p.setProperty('T_LOCK', String(Date.now()+15*6e4)); p.setProperty('T_FAILS','0'); } return {ok:false, error:'wrong_key'}; }
  p.setProperty('T_FAILS','0');
  return fn();
}
function classes_(){ const v = classSheet_().getDataRange().getValues().slice(1); const st = students_().getDataRange().getValues().slice(1);
  return v.filter(x=>x[0]).map(x=>{ const ids=parseIds_(x[4]); return {code:x[0], name:x[1], active:x[2]!==false && x[2]!=='FALSE', created:time_(x[3]), ids, islands:parseIslands_(x[5]), count:st.filter(s=>s[COL.cls]===x[0]).length}; }); }
function createClass_(code, name){ code = normCode_(code); if(!code) return {ok:false, error:'bad_class'}; if(findClass_(code)) return {ok:false, error:'class_exists'};
  classSheet_().appendRow([code, String(name||'').slice(0,40), true, new Date(), '', '']); return {ok:true, code}; }
function toggleClass_(code, active){ const f = classRow_(code); if(!f) return {ok:false, error:'no_class'}; f.sheet.getRange(f.row,3).setValue(!!active); return {ok:true}; }
function setList_(code, ids){ const f = classRow_(code); if(!f) return {ok:false, error:'no_class'};
  const list = parseIds_(Array.isArray(ids) ? ids.join(',') : ids); f.sheet.getRange(f.row,5).setNumberFormat('@').setValue(list.join(', ')); return {ok:true, count:list.length, ids:list}; }
// per-island settings for a class: mode "auto" (follow progress) | "open" | "closed" (under maintenance), and an optional opening date
function parseIslands_(s){ let a=[]; try{ a=JSON.parse(s||'[]'); }catch(e){} return ISLANDS.map((_,i)=>{ const x=a[i]||{}; return {mode:['auto','open','closed'].indexOf(x.mode)>=0?x.mode:'auto', date:/^\d{4}-\d{2}-\d{2}$/.test(x.date||'')?x.date:''}; }); }
function islandsOf_(cls){ const f=classRow_(cls); return f ? parseIslands_(f.values[5]) : parseIslands_(''); }
function setIslands_(code, islands){ const f=classRow_(code); if(!f) return {ok:false, error:'no_class'}; const v=parseIslands_(JSON.stringify(islands||[]));
  f.sheet.getRange(f.row,6).setValue(JSON.stringify(v)); return {ok:true, islands:v}; }
// remove every record in the class whose Student ID is not on the class list
function purge_(cls, quiet){ const k = findClass_(normCode_(cls)); if(!k) return {ok:false, error:'no_class'}; if(!k.ids.length) return {ok:false, error:'no_list'};
  const sh = students_(), v = sh.getDataRange().getValues(); let removed = 0;
  for(let i=v.length-1;i>=1;i--){ if(v[i][COL.cls]===k.code && k.ids.indexOf(normSid_(v[i][COL.sid]))<0){ sh.deleteRow(i+1); removed++; } }
  return {ok:true, removed}; }
function roster_(cls){ cls = normCode_(cls); const k = findClass_(cls); const v = students_().getDataRange().getValues().slice(1).filter(x=>x[COL.cls]===cls);
  return {ok:true, cls, ids:k?k.ids:[], students:v.map(x=>{ const sid=String(x[COL.sid]); return {sid, nick:x[COL.nick], onList: !k || !k.ids.length || k.ids.indexOf(normSid_(sid))>=0, created:time_(x[COL.created]), last:time_(x[COL.last]), updated:time_(x[COL.updated]), pct:x[COL.pct]||0, done:x[COL.done]||0, stars:x[COL.stars]||0, coins:x[COL.coins]||0, summary:safeJSON_(x[COL.summary]), locked:x[COL.lock] && new Date(x[COL.lock])>new Date()}; })}; }
function resetPin_(cls, sid, pin){ if(!/^\d{4}$/.test(String(pin||''))) return {ok:false, error:'bad_pin'}; const sh=students_(), f=findStudent_(sh, normCode_(cls), normSid_(sid)); if(!f) return {ok:false, error:'no_student'};
  const salt=Utilities.getUuid(); sh.getRange(f.row, COL.salt+1, 1, 2).setValues([[salt, sha(salt+pin)]]); sh.getRange(f.row, COL.token+1, 1, 4).setValues([['','',0,'']]); return {ok:true}; }
function deleteStudent_(cls, sid){ const sh=students_(), f=findStudent_(sh, normCode_(cls), normSid_(sid)); if(!f) return {ok:false, error:'no_student'}; sh.deleteRow(f.row); return {ok:true}; }

/* ---------------- helpers ---------------- */
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sha(s){ return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(b=>('0'+(b&255).toString(16)).slice(-2)).join(''); }
function normCode_(c){ c = String(c||'').trim().toUpperCase(); return /^[A-Z0-9]{3,12}$/.test(c) ? c : ''; }
function normSid_(s){ s = String(s||'').replace(/[\s\-_.]/g,'').toUpperCase(); return /^[A-Z0-9]{5,12}$/.test(s) ? s : ''; }
function normNick_(n){ n = String(n||'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim(); return n && n.length<=16 ? n : ''; }
function parseIds_(s){ const out=[]; String(s||'').split(/[\s,;，、]+/).forEach(x=>{ const v=normSid_(x); if(v && out.indexOf(v)<0) out.push(v); }); return out; }
function time_(d){ return d ? new Date(d).getTime() : 0; }
function safeJSON_(s){ try{ return s ? JSON.parse(s) : null; }catch(e){ return null; } }
function parseState_(s){ return safeJSON_(s); }
// create the tabs; if an older layout is found, keep it under a new name and start a fresh tab
function classSheet_(){ const ss=SpreadsheetApp.getActive(); let sh=ss.getSheetByName(SH_CLASSES);
  if(!sh){ sh=ss.insertSheet(SH_CLASSES); sh.appendRow(CLASS_HEADERS); sh.setFrozenRows(1); }
  else { if(sh.getRange(1,5).getValue()!==CLASS_HEADERS[4]) sh.getRange(1,5).setValue(CLASS_HEADERS[4]); if(sh.getRange(1,6).getValue()!==CLASS_HEADERS[5]) sh.getRange(1,6).setValue(CLASS_HEADERS[5]); }
  return sh; }
function students_(){ const ss=SpreadsheetApp.getActive(); let sh=ss.getSheetByName(SH_STUDENTS);
  if(sh && sh.getRange(1,2).getValue()!==STUDENT_HEADERS[1]){ sh.setName(SH_STUDENTS+' (旧 old '+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd HHmm')+')'); sh=null; }
  if(!sh){ sh=ss.insertSheet(SH_STUDENTS); sh.appendRow(STUDENT_HEADERS); sh.setFrozenRows(1); sh.getRange('B:B').setNumberFormat('@'); sh.hideColumns(COL.salt+1, 2); sh.hideColumns(COL.token+1, 4); sh.hideColumns(COL.summary+1, 2); }
  return sh; }
function classRow_(code){ const sh=classSheet_(), v=sh.getDataRange().getValues(), c=normCode_(code); for(let i=1;i<v.length;i++) if(v[i][0]===c) return {sheet:sh, row:i+1, values:v[i]}; return null; }
function findClass_(code){ const f=classRow_(code); return f ? {code:f.values[0], active:f.values[2]!==false && f.values[2]!=='FALSE', ids:parseIds_(f.values[4])} : null; }
function findStudent_(sh, cls, sid){ if(!sid) return null; const n = sh.getLastRow(); if(n < 2) return null;
  const v = sh.getRange(1, 1, n, COL.lock+1).getValues();          // only the columns needed to find the student, not the big save-state column
  for(let i=1;i<v.length;i++) if(v[i][COL.cls]===cls && normSid_(v[i][COL.sid])===sid) return {row:i+1, values:sh.getRange(i+1, 1, 1, sh.getLastColumn()).getValues()[0]};
  return null; }
// a login token -> its row number is cached for a few hours, so a save reads one small row instead of the whole sheet
const TOKEN_CACHE_SEC = 21600;
function cacheRow_(token, row){ try{ CacheService.getScriptCache().put('r:'+token, String(row), TOKEN_CACHE_SEC); }catch(e){} }
function auth_(token, full){
  token = String(token||''); if(token.length<20) return null;
  const sh = students_(), width = full ? sh.getLastColumn() : COL.exp+1, last = sh.getLastRow();
  const ok = (row, v) => { if(v[COL.token]!==token) return null; if(v[COL.exp] && new Date(v[COL.exp]) < new Date()) return null; return {sheet:sh, row, values:v}; };
  let hit = 0; try{ hit = Number(CacheService.getScriptCache().get('r:'+token)||0); }catch(e){}
  if(hit>1 && hit<=last){ const a = ok(hit, sh.getRange(hit, 1, 1, width).getValues()[0]); if(a) return a; }   // cached row still belongs to this token
  if(last<2) return null;
  const v = sh.getRange(1, 1, last, COL.exp+1).getValues();       // slow path (first request, or rows moved after a delete): scan only the first columns
  for(let i=1;i<v.length;i++) if(v[i][COL.token]===token){ cacheRow_(token, i+1); return ok(i+1, full ? sh.getRange(i+1, 1, 1, sh.getLastColumn()).getValues()[0] : v[i]); }
  return null; }
