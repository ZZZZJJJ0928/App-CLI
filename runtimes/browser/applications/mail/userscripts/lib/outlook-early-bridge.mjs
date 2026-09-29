// Outlook binds Worker.postMessage before an asynchronous userscript may load.
// The Controller installs this read-only hook at document creation in its owned
// tab. The managed Reader remains the only provider of list/download operations.
export function installOutlookEarlyBridge() {
  if(window.top!==window || !['https://outlook.live.com','https://outlook.office.com','https://outlook.office365.com'].includes(location.origin))return null;
  if(window.SparkClawOutlookEarlyBridge)return window.SparkClawOutlookEarlyBridge;
  const NativeWorker=window.Worker,NativeChannel=window.MessageChannel,originalFetch=window.fetch;
  if(!NativeWorker||!NativeChannel)return null;
  const queue=[],listeners=[];let consumer=null,startup=null,active=true;
  const observe=(worker,message)=>{
    const operation=message?.argumentList?.[0]?.value?.operationName;
    if(!['ItemRows','ConversationRows','ItemExport'].includes(operation))return;
    const item={worker,message:structuredClone(message)};
    if(consumer)consumer.request(item.worker,item.message);
    else {queue.push(item);if(queue.length>40)queue.shift();}
  };
  const Worker=class extends NativeWorker {postMessage(message,...rest){try{observe(this,message);}catch{}return super.postMessage(message,...rest);}};
  const Channel=class extends NativeChannel {constructor(){super();for(const port of [this.port1,this.port2]){
    const listener=event=>consumer?.result(event,port);port.addEventListener('message',listener);listeners.push([port,listener]);
  }}};
  window.Worker=Worker;window.MessageChannel=Channel;
  const fetch=async function(...args){
    const next=(...values)=>originalFetch.apply(this,values);
    const response=await (consumer?.fetchSearch?consumer.fetchSearch(args,next):next(...args));
    try{
      const url=new URL(response.url);
      if(active&&response.ok&&url.origin===location.origin&&/^\/owa\/\d+\/startupdata\.ashx$/.test(url.pathname))void(async()=>{
        const reader=response.clone().body.getReader(),chunks=[];let size=0;
        try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>10<<20){void reader.cancel();return;}chunks.push(value);}}
        finally{reader.releaseLock();}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const value=JSON.parse(new TextDecoder().decode(bytes));if(!active)return;
        // Retain hierarchy evidence only, never session secrets or mail bodies.
        startup={owaUserConfig:{SessionSettings:{UserEmailAddress:value?.owaUserConfig?.SessionSettings?.UserEmailAddress}},findFolders:value.findFolders,findConversation:{Body:{FolderId:value?.findConversation?.Body?.FolderId}}};
        consumer?.startup?.(startup);
      })().catch(()=>{});
    }catch{}
    return response;
  };
  window.fetch=fetch;
  const bridge=Object.freeze({
    attach(next){if(!active)return;consumer=next;for(const item of queue.splice(0))consumer.request(item.worker,item.message);if(startup)consumer.startup?.(startup);},
    detach(next){if(consumer===next)consumer=null;},
    dispose(){
      active=false;consumer=null;startup=null;queue.length=0;
      for(const [port,listener]of listeners)port.removeEventListener('message',listener);listeners.length=0;
      if(window.Worker===Worker)window.Worker=NativeWorker;
      if(window.MessageChannel===Channel)window.MessageChannel=NativeChannel;
      if(window.fetch===fetch)window.fetch=originalFetch;
      delete window.SparkClawOutlookEarlyBridge;
    },
  });
  Object.defineProperty(window,'SparkClawOutlookEarlyBridge',{configurable:true,value:bridge});
  return bridge;
}
