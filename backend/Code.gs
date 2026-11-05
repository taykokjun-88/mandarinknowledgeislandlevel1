/**
 * Mandarin 1的知识群岛 — 登入与进度后台 (Google Apps Script, bound to a Google Sheet)
 *
 * 部署方法见 backend/部署说明.md。Setup guide: backend/部署说明.md
 *
 * Students sign in with: class code + nickname + 4-digit PIN.
 * The teacher dashboard (teacher.html) signs in with the teacher password set from the sheet's menu.
 * No personal data is required; PINs are stored only as salted SHA-256 hashes.
 */

const SH_CLASSES = '班级 Classes';
const SH_STUDENTS = '学生 Students';
const ISLANDS = ['M1','M2','M3','M4','M5','M6','M7','M8','M9'];
const STUDENT_HEADERS = ['班级 Class','昵称 Nickname','key','salt','pinHash','建立 Created','最后登入 Last login','token','tokenExp','fails','lockUntil',
  '最后更新 Updated','总进度 Overall %','完成岛 Islands done','星星 Stars','椰子币 Coins'].concat(ISLANDS).concat(['summary','state']);
const COL = { cls:0, nick:1, key:2, salt:3, hash:4, created:5, last:6, token:7, exp:8, fails:9, lock:10, updated:11, pct:12, done:13, stars:14, coins:15, isl:16, summary:25, state:26 };
const TOKEN_DAYS = 90, MAX_FAILS = 5, LOCK_MIN = 10, MAX_STATE = 45000;

/* ---------------- sheet menu (teacher) ---------------- */
function onOpen(){
  SpreadsheetApp.getUi().createMenu('知识群岛')
    .addItem('1. 初始化表格 Set up sheets', 'setupSheets')
    .addItem('2. 设定老师密码 Set teacher password', 'setTeacherPassword')
    .addItem('3. 建立班级代码 Create a class code', 'createClassFromMenu')
    .addToUi();
}
function setupSheets(){
  const ss = SpreadsheetApp.getActive();
  let c = ss.getSheetByName(SH_CLASSES); if(!c){ c = ss.insertSheet(SH_CLASSES); c.appendRow(['代码 Code','名称 Name','开放 Active','建立 Created']); c.setFrozenRows(1); }
  let s = ss.getSheetByName(SH_STUDENTS); if(!s){ s = ss.insertSheet(SH_STUDENTS); s.appendRow(STUDENT_HEADERS); s.setFrozenRows(1); s.hideColumns(COL.key+1, 3); s.hideColumns(COL.token+1, 4); s.hideColumns(COL.summary+1, 2); }
  try{ SpreadsheetApp.getUi().alert('表格已准备好。下一步：设定老师密码。\nSheets are ready. Next: set the teacher password.'); }catch(e){}
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

/* ---------------- web API ---------------- */
function doGet(){ return json({ok:true, service:'mandarin1-isles', time:new Date().toISOString()}); }
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
    case 'tLogin':   return teacher_(r, ()=>({ok:true}));
    case 'tClasses': return teacher_(r, ()=>({ok:true, classes:classes_()}));
    case 'tCreateClass': return teacher_(r, ()=>createClass_(r.code, r.name));
    case 'tToggleClass': return teacher_(r, ()=>toggleClass_(r.code, r.active));
    case 'tRoster':  return teacher_(r, ()=>roster_(r.cls));
    case 'tResetPin': return teacher_(r, ()=>resetPin_(r.cls, r.nick, r.pin));
    case 'tDelete':  return teacher_(r, ()=>deleteStudent_(r.cls, r.nick));
    default: return {ok:false, error:'unknown_action'};
  }
}

/* ---------------- students ---------------- */
function register_(r){
  const cls = normCode_(r.cls), nick = normNick_(r.nick), pin = String(r.pin||'');
  if(!cls) return {ok:false, error:'bad_class'}; if(!nick) return {ok:false, error:'bad_nick'}; if(!/^\d{4}$/.test(pin)) return {ok:false, error:'bad_pin'};
  const k = findClass_(cls); if(!k) return {ok:false, error:'no_class'}; if(!k.active) return {ok:false, error:'class_closed'};
  const sh = students_(); if(findStudent_(sh, cls, nick)) return {ok:false, error:'nick_taken'};
  const salt = Utilities.getUuid(), now = new Date(), token = Utilities.getUuid();
  const row = new Array(STUDENT_HEADERS.length).fill('');
  row[COL.cls]=cls; row[COL.nick]=nick; row[COL.key]=nickKey_(nick); row[COL.salt]=salt; row[COL.hash]=sha(salt+pin); row[COL.created]=now; row[COL.last]=now;
  row[COL.token]=token; row[COL.exp]=new Date(now.getTime()+TOKEN_DAYS*864e5); row[COL.fails]=0; row[COL.lock]=''; row[COL.updated]=now; row[COL.state]='';
  sh.appendRow(row);
  return {ok:true, token, cls, nick, state:null, updated:0};
}
function login_(r){
  const cls = normCode_(r.cls), nick = normNick_(r.nick), pin = String(r.pin||'');
  if(!cls || !nick || !/^\d{4}$/.test(pin)) return {ok:false, error:'bad_input'};
  const sh = students_(), f = findStudent_(sh, cls, nick); if(!f) return {ok:false, error:'no_student'};
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
  return {ok:true, token, cls:v[COL.cls], nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated])};
}
function load_(r){ const a = auth_(r.token); if(!a) return {ok:false, error:'auth'}; const v=a.values; return {ok:true, cls:v[COL.cls], nick:v[COL.nick], state:parseState_(v[COL.state]), updated:time_(v[COL.updated])}; }
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
function classes_(){ const sh = classSheet_(), v = sh.getDataRange().getValues().slice(1); const st = students_().getDataRange().getValues().slice(1);
  return v.filter(x=>x[0]).map(x=>({code:x[0], name:x[1], active:x[2]!==false && x[2]!=='FALSE', created:time_(x[3]), count:st.filter(s=>s[COL.cls]===x[0]).length})); }
function createClass_(code, name){ code = normCode_(code); if(!code) return {ok:false, error:'bad_class'}; if(findClass_(code)) return {ok:false, error:'class_exists'};
  classSheet_().appendRow([code, String(name||'').slice(0,40), true, new Date()]); return {ok:true, code}; }
function toggleClass_(code, active){ const sh = classSheet_(), v = sh.getDataRange().getValues(); for(let i=1;i<v.length;i++) if(v[i][0]===normCode_(code)){ sh.getRange(i+1,3).setValue(!!active); return {ok:true}; } return {ok:false, error:'no_class'}; }
function roster_(cls){ cls = normCode_(cls); const v = students_().getDataRange().getValues().slice(1).filter(x=>x[COL.cls]===cls);
  return {ok:true, cls, students:v.map(x=>({nick:x[COL.nick], created:time_(x[COL.created]), last:time_(x[COL.last]), updated:time_(x[COL.updated]), pct:x[COL.pct]||0, done:x[COL.done]||0, stars:x[COL.stars]||0, coins:x[COL.coins]||0, summary:safeJSON_(x[COL.summary]), locked:x[COL.lock] && new Date(x[COL.lock])>new Date()}))}; }
function resetPin_(cls, nick, pin){ if(!/^\d{4}$/.test(String(pin||''))) return {ok:false, error:'bad_pin'}; const sh=students_(), f=findStudent_(sh, normCode_(cls), normNick_(nick)); if(!f) return {ok:false, error:'no_student'};
  const salt=Utilities.getUuid(); sh.getRange(f.row, COL.salt+1, 1, 2).setValues([[salt, sha(salt+pin)]]); sh.getRange(f.row, COL.token+1, 1, 4).setValues([['','',0,'']]); return {ok:true}; }
function deleteStudent_(cls, nick){ const sh=students_(), f=findStudent_(sh, normCode_(cls), normNick_(nick)); if(!f) return {ok:false, error:'no_student'}; sh.deleteRow(f.row); return {ok:true}; }

/* ---------------- helpers ---------------- */
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sha(s){ return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(b=>('0'+(b&255).toString(16)).slice(-2)).join(''); }
function normCode_(c){ c = String(c||'').trim().toUpperCase(); return /^[A-Z0-9]{3,12}$/.test(c) ? c : ''; }
function normNick_(n){ n = String(n||'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim(); return n && n.length<=16 ? n : ''; }
function nickKey_(n){ return n.toLowerCase(); }
function time_(d){ return d ? new Date(d).getTime() : 0; }
function safeJSON_(s){ try{ return s ? JSON.parse(s) : null; }catch(e){ return null; } }
function parseState_(s){ return safeJSON_(s); }
function classSheet_(){ let sh = SpreadsheetApp.getActive().getSheetByName(SH_CLASSES); if(!sh){ setupSheetsQuiet_(); sh = SpreadsheetApp.getActive().getSheetByName(SH_CLASSES); } return sh; }
function students_(){ let sh = SpreadsheetApp.getActive().getSheetByName(SH_STUDENTS); if(!sh){ setupSheetsQuiet_(); sh = SpreadsheetApp.getActive().getSheetByName(SH_STUDENTS); } return sh; }
function setupSheetsQuiet_(){ const ss = SpreadsheetApp.getActive();
  if(!ss.getSheetByName(SH_CLASSES)){ const c=ss.insertSheet(SH_CLASSES); c.appendRow(['代码 Code','名称 Name','开放 Active','建立 Created']); c.setFrozenRows(1); }
  if(!ss.getSheetByName(SH_STUDENTS)){ const s=ss.insertSheet(SH_STUDENTS); s.appendRow(STUDENT_HEADERS); s.setFrozenRows(1); } }
function findClass_(code){ const v = classSheet_().getDataRange().getValues(); for(let i=1;i<v.length;i++) if(v[i][0]===code) return {code, active:v[i][2]!==false && v[i][2]!=='FALSE'}; return null; }
function findStudent_(sh, cls, nick){ const v = sh.getDataRange().getValues(), k = nickKey_(nick); for(let i=1;i<v.length;i++) if(v[i][COL.cls]===cls && v[i][COL.key]===k) return {row:i+1, values:v[i]}; return null; }
function auth_(token){ token = String(token||''); if(token.length<20) return null; const sh = students_(), v = sh.getDataRange().getValues();
  for(let i=1;i<v.length;i++) if(v[i][COL.token]===token){ if(v[i][COL.exp] && new Date(v[i][COL.exp]) < new Date()) return null; return {sheet:sh, row:i+1, values:v[i]}; } return null; }
