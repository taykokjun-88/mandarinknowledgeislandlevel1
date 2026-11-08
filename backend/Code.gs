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
function doGet(){ return json({ok:true, service:'mandarin1-isles', version:2, time:new Date().toISOString()}); }
function doPost(e){
  let req; try{ req = JSON.parse(e.postData.contents || '{}'); }catch(err){ return json({ok:false, error:'bad_json'}); }
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
    case 'cfg':      { const a = auth_(r.token); if(!a) return {ok:false, error:'auth'}; return {ok:true, islands:islandsOf_(a.values[COL.cls])}; }
    case 'tLogin':   return teacher_(r, ()=>({ok:true}));
    case 'tClasses': return teacher_(r, ()=>({ok:true, classes:classes_()}));
    case 'tCreateClass': return teacher_(r, ()=>createClass_(r.code, r.name));
    case 'tToggleClass': return teacher_(r, ()=>toggleClass_(r.code, r.active));
    case 'tSetList': return teacher_(r, ()=>setList_(r.code, r.ids));
    case 'tPurge':   return teacher_(r, ()=>purge_(r.cls));
    case 'tSetIslands': return teacher_(r, ()=>setIslands_(r.code, r.islands));
    case 'tRoster':  return teacher_(r, ()=>roster_(r.cls));
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
  return {ok:true, token, cls:v[COL.cls], sid:String(v[COL.sid]), nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated]), islands:islandsOf_(v[COL.cls])};
}
function load_(r){ const a = auth_(r.token); if(!a) return {ok:false, error:'auth'}; const v=a.values; return {ok:true, cls:v[COL.cls], sid:String(v[COL.sid]), nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated]), islands:islandsOf_(v[COL.cls])}; }
function save_(r){
  const a = auth_(r.token); if(!a) return {ok:false, error:'auth'};
  const st = JSON.stringify(r.state||{}); if(st.length > MAX_STATE) return {ok:false, error:'too_big'};
  const s = r.summary || {}, now = new Date(), isl = ISLANDS.map((_,i)=>{ const x=(s.islands||[])[i]||{}; return x.locked ? '🔒' : `★${x.s||0} ${x.best!=null?x.best+'/'+(x.n||10):'—'} · ${x.games||0}/7 · ${x.pct||0}%`; });
  const vals = [now, Number(s.pct||0), Number(s.done||0), Number(s.stars||0), Number(s.coins||0)].concat(isl).concat([JSON.stringify(s), st]);
  a.sheet.getRange(a.row, COL.updated+1, 1, vals.length).setValues([vals]);
  return {ok:true, updated:now.getTime()};
}
function logout_(r){ const a = auth_(r.token); if(a) a.sheet.getRange(a.row, COL.token+1, 1, 2).setValues([['','']]); return {ok:true}; }

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
function findStudent_(sh, cls, sid){ if(!sid) return null; const v = sh.getDataRange().getValues(); for(let i=1;i<v.length;i++) if(v[i][COL.cls]===cls && normSid_(v[i][COL.sid])===sid) return {row:i+1, values:v[i]}; return null; }
function auth_(token){ token = String(token||''); if(token.length<20) return null; const sh = students_(), v = sh.getDataRange().getValues();
  for(let i=1;i<v.length;i++) if(v[i][COL.token]===token){ if(v[i][COL.exp] && new Date(v[i][COL.exp]) < new Date()) return null; return {sheet:sh, row:i+1, values:v[i]}; } return null; }
