// Run: node --test server/security.test.cjs
// Uses an isolated temporary PostgreSQL schema; never writes application tables.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const pg = require('pg');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');

test('sessions, password migration, permissions, validation and concurrent saves', { timeout: 60000 }, async t => {
  const envPath = path.join(root, '.env');
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const admin = new pg.Client({connectionString:process.env.DATABASE_URL || env.DATABASE_URL});
  await admin.connect();
  const schema = 'security_test_'+crypto.randomBytes(8).toString('hex');
  const scratch = fs.mkdtempSync(path.join(process.env.SECURITY_TEST_WORKDIR || os.tmpdir(),'occupancy-security-'));
  let child;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".users (
      id SERIAL PRIMARY KEY, username VARCHAR(64) UNIQUE NOT NULL,display_name VARCHAR(128) NOT NULL,
      password VARCHAR(128) NOT NULL DEFAULT 'admin',role_title VARCHAR(128) DEFAULT 'Участник',
      avatar_color VARCHAR(32) DEFAULT '#3B82F6',schedule_config JSONB NOT NULL DEFAULT '{}',
      overrides JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    const secret = crypto.randomBytes(16).toString('hex');
    await admin.query(`INSERT INTO "${schema}".users(username,display_name,password,schedule_config) VALUES('legacy_user','Legacy',$1,'{"mode":"manual"}')`, [secret]);
    const legacyOverrides = {
      '2026-09-01': {status:'free',slots:[],note:'Выходной'},
      '2026-09-02': {status:'working',slots:[{start:'06:00',end:'14:00',label:'Первая смена'},{start:'10:00',end:'16:00'}],note:'Пересечения'},
      '2026-09-03': {status:'partial',slots:[{start:'22:00',end:'06:00',label:'Работа'},{start:'20:00',end:'24:00',label:'Ночная смена'}]},
    };
    const expectedMigratedOverrides = {
      '2026-09-01': {status:'free',slots:[],note:'Выходной'},
      '2026-09-02': {status:'working',slots:[{start:'06:00',end:'14:00'},{start:'10:00',end:'16:00'}],note:'Пересечения'},
      '2026-09-03': {status:'partial',slots:[{start:'22:00',end:'06:00'},{start:'20:00',end:'24:00'}],note:'Ночная смена'},
    };
    await admin.query(`UPDATE "${schema}".users SET overrides=$1 WHERE username='legacy_user'`,[JSON.stringify(legacyOverrides)]);
    const iconData='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M2 2h20v20H2z" fill="black"/></svg>').toString('base64');
    const legacyStyle={bgColor:'#e11d48',patternColor:'#fda4af',patternType:'symbols',symbol:iconData,iconHistory:[iconData,'⚡']};
    await admin.query(`ALTER TABLE "${schema}".users ADD COLUMN timeline_style JSONB NOT NULL DEFAULT '{"bgColor":"#e11d48","patternColor":"#fda4af","patternType":"stripes","symbol":"⚡"}'`);
    await admin.query(`UPDATE "${schema}".users SET timeline_style=$1 WHERE username='legacy_user'`,[JSON.stringify(legacyStyle)]);
    const dbUrl = new URL(process.env.DATABASE_URL || env.DATABASE_URL);
    dbUrl.searchParams.set('options',`-c search_path=${schema}`);
    const bundle = path.join(scratch,'server.cjs');
    esbuild.buildSync({entryPoints:[path.join(root,'server/index.ts')],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'cjs',tsconfig:path.join(root,'tsconfig.json'),logLevel:'silent'});
    const portProbe = net.createServer();
    await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));
    const port = portProbe.address().port;
    await new Promise(r=>portProbe.close(r));
    let logs='';
    child = spawn(process.execPath,[bundle],{cwd:scratch,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DATABASE_URL:dbUrl.toString(),SCHEDULE_TIMEZONE:'Asia/Yekaterinburg',PORT:String(port),NODE_PATH:path.join(root,'node_modules')}});
    child.stdout.on('data',b=>logs+=b); child.stderr.on('data',b=>logs+=b);
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++){
      try{const r=await fetch(base+'/api/auth/me');if(r.status===401){ready=true;break;}}catch{}
      if(child.exitCode!==null)break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(ready,'isolated server started: '+logs.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]'));
    const call=async(method,url,body,cookie='',extra={})=>{
      const r=await fetch(base+url,{method,headers:{...(method==='GET'?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...extra},...(method==='GET'?{}:{body:JSON.stringify(body ?? {})})});
      return {status:r.status,data:await r.json(),cookies:r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '),raw:r};
    };
    let a,b,c;
    await t.test('legacy passwords migrate without changing the password', async()=>{
      const row=(await admin.query(`SELECT password FROM "${schema}".users`)).rows[0];
      assert.match(row.password,/^scrypt\$/); assert.notEqual(row.password,secret);
      a=await call('POST','/api/auth/login',{username:'legacy_user',password:secret});
      assert.equal(a.status,200);assert.ok(a.cookies.includes('syncro_session='));
      assert.ok(a.raw.headers.getSetCookie().every(v=>v.includes('HttpOnly')&&v.includes('SameSite=Strict')));
      assert.equal(a.data.password,undefined);
    });
    await t.test('registration hashes passwords and wrong password fails',async()=>{
      b=await call('POST','/api/auth/register',{username:'member_user',display_name:'Member',password:secret});
      c=await call('POST','/api/auth/register',{username:'outsider_user',display_name:'Outsider',password:secret});
      assert.equal(b.status,200);assert.equal(c.status,200);
      const hashes=(await admin.query(`SELECT password FROM "${schema}".users`)).rows;
      assert.ok(hashes.every(v=>v.password.startsWith('scrypt$')));assert.notEqual(hashes[1].password,hashes[2].password);
      assert.equal((await call('POST','/api/auth/login',{username:'legacy_user',password:'wrong'})).status,401);
    });
    await t.test('manual overrides migrate losslessly to relational dates and timestamptz intervals',async()=>{
      assert.deepEqual(a.data.overrides,expectedMigratedOverrides);
      assert.deepEqual(a.data.schedule_config,{mode:'manual'});
      const cols=await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='overrides'",[schema]);
      assert.equal(cols.rows.length,0);
      const count=(await admin.query(`SELECT (SELECT count(*)::int FROM "${schema}".day_overrides) AS days,(SELECT count(*)::int FROM "${schema}".occupancy_intervals) AS slots`)).rows[0];
      assert.deepEqual(count,{days:3,slots:4});
      const listing=await call('GET',`/api/users/${a.data.id}/overrides?from=2026-09-01&to=2026-09-30`,undefined,a.cookies);
      assert.equal(listing.status,200);assert.equal(listing.data.days.length,3);
      assert.deepEqual(listing.data.days[0].intervals,[]);assert.equal(listing.data.days[0].status,'free');
      const day=listing.data.days[1];assert.equal(day.timeZone,'Asia/Yekaterinburg');
      assert.equal(new Date(day.intervals[0].startsAt).toISOString(),'2026-09-02T01:00:00.000Z');
      assert.equal(new Date(day.intervals[0].endsAt).toISOString(),'2026-09-02T09:00:00.000Z');
      assert.equal(day.note,'Пересечения');
      const night=listing.data.days[2];
      assert.equal(night.note,'Ночная смена');
      assert.equal(new Date(night.intervals[0].endsAt).toISOString(),'2026-09-04T01:00:00.000Z');
      assert.equal(new Date(night.intervals[1].endsAt).toISOString(),'2026-09-03T19:00:00.000Z');
      assert.equal((await call('GET',`/api/users/${a.data.id}/overrides`,undefined,b.cookies)).status,403);
      assert.equal((await call('GET',`/api/users/${a.data.id}/overrides?from=2026-10-31&to=2026-10-01`,undefined,a.cookies)).status,400);
      const one=await call('GET',`/api/users/${a.data.id}/overrides/2026-09-02`,undefined,a.cookies);
      assert.deepEqual(one.data.override,expectedMigratedOverrides['2026-09-02']);
      assert.equal((await call('GET',`/api/users/${a.data.id}/overrides/2026-09-20`,undefined,a.cookies)).data.override,null);
      await assert.rejects(admin.query(`INSERT INTO "${schema}".occupancy_intervals(user_id,override_date,position,starts_at,ends_at)
        VALUES($1,'2026-09-02',999,'2026-09-02T12:00:00Z','2026-09-02T11:00:00Z')`,[a.data.id]),{code:'23514'});
    });
    await t.test('manual migration and auth initialization remain idempotent after creating views',async()=>{
      const db=new pg.Client({connectionString:dbUrl.toString()});await db.connect();
      try {
        const before=(await db.query('SELECT id,overrides,schedule_config FROM user_profiles ORDER BY id')).rows;
        const beforeIds=(await db.query('SELECT id::text FROM occupancy_intervals ORDER BY id')).rows;
        const load=(filename)=>{
          const output=esbuild.buildSync({entryPoints:[path.join(root,'server',filename)],bundle:true,packages:'external',platform:'node',format:'cjs',write:false,logLevel:'silent'}).outputFiles[0].text;
          const mod={exports:{}};new Function('require','module','exports',output)(require,mod,mod.exports);return mod.exports;
        };
        await load('auth.ts').initAuth(db);
        await load('manual-overrides.ts').migrateManualOverrides(db);
        assert.deepEqual((await db.query('SELECT id,overrides,schedule_config FROM user_profiles ORDER BY id')).rows,before);
        assert.deepEqual((await db.query('SELECT id::text FROM occupancy_intervals ORDER BY id')).rows,beforeIds);
      }finally{await db.end();}
    });
    await t.test('role_title is dropped and legacy pattern icons become files',async()=>{
      const cols=await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='role_title'",[schema]);
      assert.equal(cols.rows.length,0);assert.equal('role_title' in a.data,false);
      const stored=(await admin.query(`SELECT timeline_style FROM "${schema}".users WHERE id=$1`,[a.data.id])).rows[0].timeline_style;
      assert.match(stored.symbol,/^\/uploads\/icon_[a-f0-9]{20}\.png$/);
      assert.deepEqual(stored.iconHistory,[stored.symbol,'⚡']);
      assert.equal(JSON.stringify(stored).includes('data:'),false);
      assert.ok(fs.existsSync(path.join(scratch,stored.symbol)));
    });
    await t.test('new icon uploads and profile writes never persist data URLs; generated tiles render',async()=>{
      const upload=await call('POST','/api/upload',{kind:'icon',dataUrl:iconData},a.cookies);
      assert.equal(upload.status,200);assert.match(upload.data.url,/^\/uploads\/icon_[a-f0-9]{20}\.png$/);
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      const save=await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,timeline_style:legacyStyle},a.cookies);
      assert.equal(save.status,200);assert.equal(save.data.timeline_style.symbol,upload.data.url);
      assert.equal(JSON.stringify(save.data.timeline_style).includes('data:'),false);
      const query=new URLSearchParams({icon:upload.data.url,color:'#abcdef',scale:'1.5'});
      const tile=await fetch(base+'/api/pattern-tile?'+query,{headers:{Cookie:a.cookies}});
      assert.equal(tile.status,200);assert.match(tile.headers.get('content-type'),/image\/svg\+xml/);
      const svg=await tile.text();assert.ok(svg.includes('#abcdef'));
      const raster=await require('sharp')(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
      let visible=false;
      for(let i=0;i<raster.length;i+=4)if(raster[i+3]>0){visible=true;break;}
      assert.ok(visible,'file-backed icon remains visible inside a standalone SVG tile');
      assert.equal((await call('POST','/api/upload',{kind:'icon',dataUrl:'data:text/html;base64,WA=='},a.cookies)).status,400);
      const invalid=await fetch(base+'/api/pattern-tile?'+new URLSearchParams({icon:'/../../secret',color:'#abcdef',scale:'1'}),{headers:{Cookie:a.cookies}});
      assert.equal(invalid.status,400);
      // A second migration must preserve file URLs and revision.
      const built=esbuild.buildSync({entryPoints:[path.join(root,'server/pattern-media.ts')],bundle:true,packages:'external',platform:'node',format:'cjs',write:false,logLevel:'silent'}).outputFiles[0].text;
      const mod={exports:{}};new Function('require','module','exports',built)(require,mod,mod.exports);
      const db=new pg.Client({connectionString:dbUrl.toString()});await db.connect();
      try {
        const before=(await db.query('SELECT timeline_style,revision FROM users WHERE id=$1',[a.data.id])).rows[0];
        await mod.exports.createPatternMedia(path.join(scratch,'uploads')).migrate(db);
        const after=(await db.query('SELECT timeline_style,revision FROM users WHERE id=$1',[a.data.id])).rows[0];
        assert.deepEqual(after,before);
      } finally {await db.end();}
    });
    await t.test('identity cannot be replaced by a URL, body or local account id',async()=>{
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:0,display_name:'forged'})).status,401);
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:0,display_name:'forged'},b.cookies)).status,403);
      assert.equal((await call('POST','/api/auth/switch',{userId:a.data.id},b.cookies)).status,401);
      assert.equal((await call('POST','/api/groups',{name:'forged',owner_id:a.data.id},b.cookies)).status,403);
      assert.equal((await call('GET',`/api/groups?userId=${a.data.id}`,undefined,b.cookies)).status,403);
      assert.equal((await call('PUT',`/api/users/${a.data.id}invalid`,{revision:0,display_name:'forged'},b.cookies)).status,400);
    });
    await t.test('switching saved accounts requires a valid cookie for that account',async()=>{
      const jar=Object.fromEntries((a.cookies+'; '+b.cookies).split('; ').map(v=>v.split('=')));
      const cookie=Object.entries(jar).map(([k,v])=>k+'='+v).join('; ');
      const switched=await call('POST','/api/auth/switch',{userId:a.data.id},cookie);
      assert.equal(switched.status,200);
      assert.equal((await call('GET','/api/auth/me',undefined,switched.cookies)).data.id,a.data.id);
    });
    await t.test('saved account cards include avatars and cookie-verified login status before authentication',async()=>{
      await admin.query(`UPDATE "${schema}".users SET avatar_url='/uploads/test-avatar.webp' WHERE id=$1`,[a.data.id]);
      const url=`/api/auth/accounts?ids=${a.data.id},${b.data.id}`;
      const anonymous=await call('GET',url);
      assert.equal(anonymous.status,200);
      assert.ok(anonymous.data.every(account=>account.requiresPassword));
      const card=anonymous.data.find(account=>account.id===a.data.id);
      assert.equal(card.avatar_url,'/uploads/test-avatar.webp');
      assert.equal(card.password,undefined);assert.equal(card.schedule_config,undefined);assert.equal(card.overrides,undefined);
      assert.equal(anonymous.raw.headers.get('cache-control'),'no-store');
      const authenticated=await call('GET',url,undefined,a.cookies);
      assert.equal(authenticated.data.find(account=>account.id===a.data.id).requiresPassword,false);
      assert.equal(authenticated.data.find(account=>account.id===b.data.id).requiresPassword,true);
      const forged=await call('GET',url,undefined,`syncro_session_${b.data.id}=${a.cookies.split('; ')[0].split('=')[1]}`);
      assert.ok(forged.data.every(account=>account.requiresPassword));
    });
    const override={status:'working',slots:[{start:'06:00',end:'14:00'},{start:'10:00',end:'16:00'}]};
    await t.test('different days save concurrently; same-day stale writes and deletes conflict',async()=>{
      const both=await Promise.all(['2026-10-27','2026-10-28'].map(date=>call('PUT',`/api/users/${a.data.id}/overrides/${date}`,{expectedOverride:null,override},a.cookies)));
      assert.deepEqual(both.map(r=>r.status),[200,200]);
      const me=await call('GET','/api/auth/me',undefined,a.cookies);
      assert.equal(Object.keys(me.data.overrides).length,Object.keys(legacyOverrides).length+2);assert.equal(me.data.overrides['2026-10-27'].slots.length,2);
      assert.equal((await call('PUT',`/api/users/${a.data.id}/overrides/2026-10-27`,{expectedOverride:null,override},a.cookies)).status,409);
      assert.equal((await call('DELETE',`/api/users/${a.data.id}/overrides/2026-10-27`,{expectedOverride:null},a.cookies)).status,409);
      assert.equal((await call('DELETE',`/api/users/${a.data.id}/overrides/2026-10-27`,{expectedOverride:override},a.cookies)).status,200);
      assert.ok((await call('GET','/api/auth/me',undefined,a.cookies)).data.overrides['2026-10-28']);
    });
    await t.test('same-day concurrent edits conflict and deletion cascades only that day',async()=>{
      const date='2026-10-31';
      const results=await Promise.all(['A','B'].map(note=>call('PUT',`/api/users/${a.data.id}/overrides/${date}`,{expectedOverride:null,override:{...override,note}},a.cookies)));
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      const value=results.find(r=>r.status===200).data.override;
      const count=(await admin.query(`SELECT count(*)::int AS n FROM "${schema}".occupancy_intervals WHERE user_id=$1 AND override_date=$2`,[a.data.id,date])).rows[0].n;
      assert.equal(count,2);
      assert.equal((await call('DELETE',`/api/users/${a.data.id}/overrides/${date}`,{expectedOverride:value},a.cookies)).status,200);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".occupancy_intervals WHERE user_id=$1 AND override_date=$2`,[a.data.id,date])).rows[0].n,0);
      assert.equal((await call('GET',`/api/users/${a.data.id}/overrides?from=${date}&to=${date}`,undefined,a.cookies)).data.days.length,0);
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      assert.deepEqual(me.overrides['2026-09-01'],legacyOverrides['2026-09-01']);
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,overrides:{}},a.cookies)).status,400);
    });
    await t.test('profile CAS rejects stale versions and preserves schedule fields',async()=>{
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,display_name:'Renamed'},a.cookies)).status,200);
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,schedule_config:{mode:'manual'}},a.cookies)).status,409);
      const latest=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      assert.deepEqual(latest.overrides,me.overrides);
    });
    await t.test('malformed dates, times, cycles and bypass via profile/schedule are rejected',async()=>{
      for(const [date,value] of [['2026-02-30',override],['2026-10-27',{...override,slots:[{start:'25:00',end:'26:00'}]}],['2026-10-27',{...override,slots:[{start:'10:00',end:'10:00'}]}],['2026-10-27',{...override,status:'invalid'}]]){
        assert.equal((await call('PUT',`/api/users/${a.data.id}/overrides/${date}`,{expectedOverride:null,override:value},a.cookies)).status,400);
      }
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,schedule_config:{mode:'shift_cycle',shift:{workDays:0,offDays:0,startDate:'2026-10-27',slots:[]}}},a.cookies)).status,400);
      assert.equal((await call('PATCH',`/api/users/${a.data.id}/schedule`,{revision:me.revision,mode:'fixed_weekly'},a.cookies)).status,400);
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,overrides:{'invalid':override}},a.cookies)).status,400);
      const night={status:'working',slots:[{start:'22:00',end:'06:00'},{start:'20:00',end:'24:00'}]};
      assert.equal((await call('PUT',`/api/users/${a.data.id}/overrides/2026-10-29`,{expectedOverride:null,override:night},a.cookies)).status,200);
    });
    await t.test('JSON member-order updates preserve other groups',async()=>{
      const r=await Promise.all(['one','two'].map(groupKey=>call('PUT',`/api/users/${a.data.id}/member-order`,{groupKey,memberIds:[a.data.id,b.data.id]},a.cookies)));
      assert.ok(r.every(v=>v.status===200));
      assert.equal(Object.keys((await call('GET','/api/auth/me',undefined,a.cookies)).data.member_orders).length,2);
    });
    await t.test('group permissions, pending invitations, ownership and leave are enforced',async()=>{
      const created=await call('POST','/api/groups',{name:'Test',owner_id:a.data.id},a.cookies);assert.equal(created.status,200);
      const gid=created.data.id;
      assert.equal((await call('DELETE',`/api/groups/${gid}`,{},b.cookies)).status,403);
      assert.equal((await call('POST',`/api/groups/${gid}/invite`,{username:'outsider_user'},b.cookies)).status,403);
      assert.equal((await call('POST',`/api/groups/${gid}/invite`,{username:'member_user'},a.cookies)).status,200);
      assert.equal((await call('POST',`/api/groups/${gid}/respond`,{user_id:b.data.id,action:'accept'},c.cookies)).status,403);
      assert.equal((await call('POST',`/api/groups/${gid}/respond`,{action:'accept'},b.cookies)).status,200);
      assert.equal((await call('PUT',`/api/groups/${gid}`,{name:'forged'},b.cookies)).status,403);
      assert.equal((await call('DELETE',`/api/groups/${gid}/members/${a.data.id}`,{},b.cookies)).status,403);
      assert.equal((await call('POST',`/api/groups/${gid}/transfer-owner`,{new_owner_id:c.data.id},a.cookies)).status,400);
      assert.equal((await call('DELETE',`/api/groups/${gid}/members/${a.data.id}`,{},a.cookies)).status,200);
      const group=(await call('GET','/api/groups',undefined,b.cookies)).data[0];assert.equal(group.owner_id,b.data.id);
      assert.equal((await call('POST',`/api/groups/${gid}/respond`,{action:'decline'},b.cookies)).status,409);
      assert.equal((await call('DELETE',`/api/groups/${gid}`,{},b.cookies)).status,200);
    });
    await t.test('group invite deep links preview, join, reset and prevent unauthorized resets',async()=>{
      const created=await call('POST','/api/groups',{name:'Invite Group',owner_id:a.data.id},a.cookies);
      assert.equal(created.status,200);
      const gid=created.data.id;
      const initialCode=created.data.invite_code;
      assert.ok(initialCode && initialCode.length>=8);

      // Public preview without authentication
      const previewAnon=await call('GET',`/api/invites/${initialCode}`);
      assert.equal(previewAnon.status,200);
      assert.equal(previewAnon.data.name,'Invite Group');
      assert.equal(previewAnon.data.owner.username,a.data.username);
      assert.equal(previewAnon.data.my_status,null);
      assert.equal(previewAnon.data.members_count,1);

      // Preview with authenticated member
      const previewA=await call('GET',`/api/invites/${initialCode}`,undefined,a.cookies);
      assert.equal(previewA.status,200);
      assert.equal(previewA.data.my_status,'accepted');

      // Non-owner cannot reset invite code
      assert.equal((await call('POST',`/api/groups/${gid}/reset-invite`,{},b.cookies)).status,403);

      // User C joins via invite link
      const joinC=await call('POST',`/api/invites/${initialCode}/join`,{},c.cookies);
      assert.equal(joinC.status,200);
      assert.equal(joinC.data.ok,true);

      // User C joins again -> already member
      const joinCAgain=await call('POST',`/api/invites/${initialCode}/join`,{},c.cookies);
      assert.equal(joinCAgain.status,200);
      assert.equal(joinCAgain.data.already_member,true);

      // Owner resets invite code
      const resetRes=await call('POST',`/api/groups/${gid}/reset-invite`,{},a.cookies);
      assert.equal(resetRes.status,200);
      const newCode=resetRes.data.invite_code;
      assert.ok(newCode && newCode!==initialCode);

      // Old invite code now gives 404
      assert.equal((await call('GET',`/api/invites/${initialCode}`)).status,404);
      assert.equal((await call('POST',`/api/invites/${initialCode}/join`,{},b.cookies)).status,404);

      // New invite code works
      const previewNew=await call('GET',`/api/invites/${newCode}`);
      assert.equal(previewNew.status,200);
      assert.equal(previewNew.data.members_count,2);

      // User B joins via new invite code
      assert.equal((await call('POST',`/api/invites/${newCode}/join`,{},b.cookies)).status,200);

      // Clean up group
      assert.equal((await call('DELETE',`/api/groups/${gid}`,{},a.cookies)).status,200);
    });
    await t.test('cross-origin writes and expired/revoked sessions fail',async()=>{
      assert.equal((await call('POST','/api/groups',{name:'x'},a.cookies,{Origin:'https://evil.example'})).status,403);
      const expired=crypto.randomBytes(32).toString('hex');
      await admin.query(`INSERT INTO "${schema}".auth_sessions VALUES($1,$2,CURRENT_TIMESTAMP-INTERVAL '1 minute')`,[crypto.createHash('sha256').update(expired).digest('hex'),a.data.id]);
      assert.equal((await call('GET','/api/auth/me',undefined,'syncro_session='+expired)).status,401);
      assert.equal((await call('POST','/api/auth/logout',{},b.cookies)).status,200);
      assert.equal((await call('GET','/api/auth/me',undefined,b.cookies)).status,401);
      const cards=await call('GET',`/api/auth/accounts?ids=${b.data.id}`,undefined,b.cookies);
      assert.equal(cards.data[0].requiresPassword,true);
    });
    await t.test('API documentation describes authentication and conflict checks',async()=>{
      const r=await call('GET','/api/openapi.json');assert.equal(r.status,200);
      assert.ok(r.data.components.securitySchemes.cookieSession);
      assert.ok(r.data.components.schemas.UpdateUserRequest.required.includes('revision'));
      assert.ok(r.data.paths['/api/users/{id}/overrides/{date}'].put.requestBody.content['application/json'].schema.required.includes('expectedOverride'));
      assert.ok(r.data.paths['/api/users/{id}/overrides'].get);
      assert.ok(r.data.paths['/api/users/{id}/overrides/{date}'].get);
      assert.equal(r.data.components.schemas.ManualInterval.properties.startsAt.format,'date-time');
      assert.equal(r.data.components.schemas.UpdateUserRequest.properties.overrides,undefined);
    });
    await t.test('user profile time_zone updates and shifts timeline/availability across timezones and midnight',async()=>{
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      assert.equal(me.time_zone,'Asia/Yekaterinburg');
      assert.equal((await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,time_zone:'Not/AZone'},a.cookies)).status,400);
      const updated=await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,time_zone:'Europe/Moscow'},a.cookies);
      assert.equal(updated.status,200);
      assert.equal(updated.data.time_zone,'Europe/Moscow');

      const ovRes=await call('PUT',`/api/users/${a.data.id}/overrides/2026-11-05`,{
        expectedOverride:null,
        override:{status:'working',slots:[{start:'00:30',end:'03:00'},{start:'09:00',end:'18:00'}]}
      },a.cookies);
      assert.equal(ovRes.status,200);

      const grp=await call('POST','/api/groups',{name:'TZ Group',owner_id:a.data.id},a.cookies);
      assert.equal(grp.status,200);
      const gid=grp.data.id;

      const availYek=await call('GET',`/api/groups/${gid}/availability?startDate=2026-11-04&days=2&timeZone=Asia/Yekaterinburg`,undefined,a.cookies);
      assert.equal(availYek.status,200);
      assert.equal(availYek.data.query.timeZone,'Asia/Yekaterinburg');
      const day5Yek=availYek.data.members[0].dailySchedule.find(d=>d.dateStr==='2026-11-05');
      assert.deepEqual(day5Yek.slots,[{start:'00:30',end:'03:00'},{start:'09:00',end:'18:00'}]);

      const availMsk=await call('GET',`/api/groups/${gid}/availability?startDate=2026-11-04&days=2`,undefined,a.cookies);
      assert.equal(availMsk.status,200);
      assert.equal(availMsk.data.query.timeZone,'Europe/Moscow');
      const day4Msk=availMsk.data.members[0].dailySchedule.find(d=>d.dateStr==='2026-11-04');
      const day5Msk=availMsk.data.members[0].dailySchedule.find(d=>d.dateStr==='2026-11-05');
      assert.ok(day4Msk.slots.some(s=>s.start==='22:30'&&s.end==='24:00'));
      assert.deepEqual(day5Msk.slots,[{start:'00:00',end:'01:00'},{start:'07:00',end:'16:00'}]);
    });
    await t.test('password change revokes old sessions and preserves new login',async()=>{
      const oldCookies=a.cookies;
      const changed=await call('POST',`/api/users/${a.data.id}/change-password`,{currentPassword:secret,newPassword:'new-'+secret},a.cookies);
      assert.equal(changed.status,200);assert.equal((await call('GET','/api/auth/me',undefined,oldCookies)).status,401);
      assert.equal((await call('GET','/api/auth/me',undefined,changed.cookies)).status,200);
      assert.equal((await call('POST','/api/auth/login',{username:'legacy_user',password:secret})).status,401);
      assert.equal((await call('POST','/api/auth/login',{username:'legacy_user',password:'new-'+secret})).status,200);
      a.cookies=changed.cookies;
    });
    await t.test('admin dashboard stats, @qkeeper super-admin role management, and orphaned media cleanup',async()=>{
      // Regular user cannot read admin stats
      assert.equal((await call('GET','/api/admin/stats',undefined,a.cookies)).status,403);

      // Register @qkeeper -> automatically becomes super admin
      const qk=await call('POST','/api/auth/register',{username:'qkeeper',display_name:'QKeeper',password:secret});
      assert.equal(qk.status,200);
      assert.equal(qk.data.is_admin,true);
      assert.equal(qk.data.is_super_admin,true);

      // @qkeeper can read admin stats (DAU, DB size, uploads media size)
      const statsRes=await call('GET','/api/admin/stats?days=14',undefined,qk.cookies);
      assert.equal(statsRes.status,200);
      assert.ok(statsRes.data.kpis.totalUsers>=4);
      assert.ok(statsRes.data.kpis.dauToday>=1);
      assert.ok(statsRes.data.database.totalDbBytes>0);
      assert.equal(statsRes.data.dailySeries.length,14);

      // Only @qkeeper can grant admin rights to another user
      const grant=await call('POST','/api/admin/admins',{username:'member_user',isAdmin:true},qk.cookies);
      assert.equal(grant.status,200);
      assert.equal(grant.data.user.is_admin,true);

      // Newly appointed admin can view stats, but CANNOT grant or revoke admins
      const bLogin=await call('POST','/api/auth/login',{username:'member_user',password:secret});
      assert.equal(bLogin.status,200);
      assert.equal(bLogin.data.is_admin,true);
      assert.equal(bLogin.data.is_super_admin,false);
      assert.equal((await call('GET','/api/admin/stats',undefined,bLogin.cookies)).status,200);
      assert.equal((await call('POST','/api/admin/admins',{username:'outsider_user',isAdmin:true},bLogin.cookies)).status,403);
      assert.equal((await call('POST','/api/admin/admins',{username:'qkeeper',isAdmin:false},bLogin.cookies)).status,403);

      // Even @qkeeper cannot revoke their own super-admin status
      assert.equal((await call('POST','/api/admin/admins',{username:'qkeeper',isAdmin:false},qk.cookies)).status,400);

      // Create an orphaned file in uploads and clean it up
      const orphanPath=path.join(scratch,'uploads','avatar_00000000000000000000.webp');
      fs.writeFileSync(orphanPath,Buffer.from('orphan-data'));
      const statsWithOrphan=await call('GET','/api/admin/stats',undefined,qk.cookies);
      assert.ok(statsWithOrphan.data.media.orphanedFiles.some(f=>f.name==='avatar_00000000000000000000.webp'));

      const cleanup=await call('POST','/api/admin/media/cleanup',{},qk.cookies);
      assert.equal(cleanup.status,200);
      assert.ok(cleanup.data.deletedCount>=1);
      assert.equal(fs.existsSync(orphanPath),false);
    });
    await t.test('users can create and customize timeline groups (work, sleep, sport)',async()=>{
      const me=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      const groups=[
        {
          id:'work',
          name:'График работы',
          style:{bgColor:'#e11d48',patternColor:'#fda4af',patternType:'stripes',symbol:'⚡'},
          schedule_config:{mode:'fixed_weekly',weekly:{'1':{isWorking:true,slots:[{start:'09:00',end:'18:00'}]}}},
          is_enabled:true
        },
        {
          id:'sleep',
          name:'Сон',
          style:{bgColor:'#1e293b',patternColor:'#94a3b8',patternType:'symbols',symbol:'🌙'},
          schedule_config:{mode:'fixed_weekly',weekly:{'1':{isWorking:true,slots:[{start:'23:00',end:'07:00'}]}}},
          is_enabled:true
        }
      ];

      const save=await call('PUT',`/api/users/${a.data.id}`,{revision:me.revision,timeline_groups:groups},a.cookies);
      assert.equal(save.status,200);
      assert.equal(save.data.timeline_groups.length,2);
      assert.equal(save.data.timeline_groups[0].name,'График работы');
      assert.equal(save.data.timeline_groups[1].name,'Сон');

      // Add override specifically to sleep group
      const ovSleep=await call('PUT',`/api/users/${a.data.id}/overrides/2026-11-10`,{
        expectedOverride:null,
        groupId:'sleep',
        override:{status:'working',slots:[{start:'22:00',end:'06:00'}]}
      },a.cookies);
      assert.equal(ovSleep.status,200);
      const updatedMe=(await call('GET','/api/auth/me',undefined,a.cookies)).data;
      const sleepGroup=updatedMe.timeline_groups.find(g=>g.id==='sleep');
      assert.ok(sleepGroup.overrides['2026-11-10']);
      assert.equal(sleepGroup.overrides['2026-11-10'].slots[0].start,'22:00');
    });
  } finally {
    if(child && child.exitCode===null){ child.kill(); await new Promise(r=>child.once('exit',r)); }
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});
