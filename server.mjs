import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import worker from './src/worker.js';
import {localDatabase} from './scripts/local-db.mjs';
const root=resolve(import.meta.dirname,'web');
await mkdir('.local-data',{recursive:true});
const DB=localDatabase('.local-data/blackjack.sqlite');
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
const env={DB,ADMIN_ACCOUNT_ID:process.env.ADMIN_ACCOUNT_ID,ASSETS:{async fetch(request){try{const url=new URL(request.url),file=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+sep))return new Response('Forbidden',{status:403});const body=await readFile(file);return new Response(body,{headers:{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}});}catch{return new Response('Not found',{status:404});}}}};
http.createServer(async(req,res)=>{
  try{
    const parts=[];let length=0;for await(const part of req){length+=part.length;if(length>8192){res.writeHead(413);res.end();return;}parts.push(part);}
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(parts)}:{})});
    const response=await worker.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error.message);res.writeHead(500);res.end('Unable to serve this request.');}
}).listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173'));
