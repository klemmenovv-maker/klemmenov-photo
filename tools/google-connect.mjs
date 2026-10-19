// Run locally: node tools/google-connect.mjs /absolute/oauth.PRIVATE.json /absolute/tokens.PRIVATE.json
// One-time owner authorization only; secrets never reach the public site or stdout.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
const [credentialsPath,outputPath,urlPath]=process.argv.slice(2);
if(!credentialsPath||!outputPath) throw Error('Provide credentials path and private token output path');
const {web:c}=JSON.parse(fs.readFileSync(credentialsPath,'utf8'));
const redirect='http://127.0.0.1:8977/oauth/callback';
const state=crypto.randomBytes(32).toString('base64url');
const verifier=crypto.randomBytes(48).toString('base64url');
const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
const params=new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/calendar.events.readonly',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256',login_hint:'klemmenovv@gmail.com'});
let used=false;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://127.0.0.1:8977');
 if(url.pathname!=='/oauth/callback'){res.writeHead(404);res.end('Not found');return;}
 if(used||url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid authorization state.');return;}
 if(url.searchParams.has('error')){res.writeHead(400);res.end('Authorization was not granted. You can close this window.');return;}
 const code=url.searchParams.get('code');if(!code){res.writeHead(400);res.end('Missing code.');return;}
 used=true;
 try{
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok||!data.refresh_token)throw Error('Token exchange unsuccessful');
  // Save only what's needed for persistent server access; no authorization code/access token.
  fs.writeFileSync(outputPath,JSON.stringify({client_id:c.client_id,client_secret:c.client_secret,refresh_token:data.refresh_token,scope:data.scope,created_at:new Date().toISOString()},null,2),{mode:0o600});fs.chmodSync(outputPath,0o600);
  res.end('<h1>Calendar connected</h1><p>Credentials saved locally. You can close this window.</p>');
  console.log('Authorization completed; private credentials saved.');server.close();
 }catch{used=false;res.writeHead(502);res.end('Token exchange failed. Restart the local helper and try again.');console.log('Token exchange failed; no secrets logged.');}
});
server.listen(8977,'127.0.0.1',()=>{const url=`https://accounts.google.com/o/oauth2/v2/auth?${params}`;if(urlPath){fs.writeFileSync(urlPath,url,{mode:0o600});console.log('Authorization URL saved locally. Waiting for owner consent.');}else console.log(url);});
setTimeout(()=>{server.close();process.exit(0);},15*60*1000).unref();
