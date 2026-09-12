import {createInterface} from 'node:readline';

export interface ToolDefinition {name:string;description:string;inputSchema:unknown}
export interface McpHandler {serverInfo:{name:string;version:string};tools:ToolDefinition[];
  call:(name:string,args:Record<string,unknown>)=>unknown}

interface Request {id?:unknown;method?:string;params?:Record<string,unknown>}

/** Newline-delimited JSON-RPC 2.0 on stdio. Read-only by construction: handlers never mutate project state. */
export async function serveMcp(handler:McpHandler):Promise<void> {
  const stream=createInterface({input:process.stdin,terminal:false});
  const write=(message:unknown):void=>{process.stdout.write(JSON.stringify(message)+'\n');};
  const respond=(id:unknown,result:unknown):void=>write({jsonrpc:'2.0',id,result});
  const fail=(id:unknown,code:number,message:string):void=>write({jsonrpc:'2.0',id,error:{code,message}});
  for await(const line of stream) {
    if(!line.trim())continue;
    let request:Request;
    try{request=JSON.parse(line) as Request;}
    catch{fail(null,-32700,'Parse error');continue;}
    if(typeof request.method==='string'&&request.method.startsWith('notifications/'))continue;
    try {
      if(request.method==='initialize') {
        const requested=(request.params as {protocolVersion?:string}|undefined)?.protocolVersion;
        respond(request.id,{protocolVersion:typeof requested==='string'?requested:'2024-11-05',
          capabilities:{tools:{}},serverInfo:handler.serverInfo});
      } else if(request.method==='tools/list')respond(request.id,{tools:handler.tools});
      else if(request.method==='tools/call') {
        const params=request.params as {name?:string;arguments?:Record<string,unknown>}|undefined;
        try {
          const result=handler.call(params?.name??'',params?.arguments??{});
          respond(request.id,{content:[{type:'text',text:JSON.stringify(result)}]});
        } catch(error) {
          respond(request.id,{content:[{type:'text',text:String((error as Error).message||error)}],isError:true});
        }
      } else fail(request.id??null,-32601,'Method not found');
    } catch(error) {fail(request.id??null,-32603,String((error as Error).message||error));}
  }
}
