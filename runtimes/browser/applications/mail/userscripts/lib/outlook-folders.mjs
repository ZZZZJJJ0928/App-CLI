// Startup FindFolders is a complete deep hierarchy only with the explicit
// terminal/count evidence. Hidden flags are the observed EWS 0x10f4 Boolean.
export function parseOutlookFolders(value) {
  const owner=value?.owaUserConfig?.SessionSettings?.UserEmailAddress;
  const root=value?.findFolders?.Body?.ResponseMessages?.Items?.[0]?.RootFolder;
  const inboxID=value?.findConversation?.Body?.FolderId?.Id;
  if(typeof owner!=='string'||typeof inboxID!=='string'||!Array.isArray(root?.Folders))return null;
  const idPattern=/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/;
  const items=root.Folders.slice(0,2000),byID=new Map(),folders=[];
  let qualified=root.IncludesLastItemInRange===true&&root.TotalItemsInView===items.length&&root.Folders.length<=2000;
  const excluded=new Set(['junkemail','drafts','sentitems','deleteditems','outbox','conversationhistory']);
  const hidden=node=>node?.ExtendedProperty?.find(p=>typeof p?.ExtendedFieldURI?.PropertyTag==='string'&&p.ExtendedFieldURI.PropertyTag.toLowerCase()==='0x10f4'&&p.ExtendedFieldURI.PropertyType==='Boolean')?.Value;
  for(const item of items){const id=item?.FolderId?.Id;if(!idPattern.test(id||'')||byID.has(id)){qualified=false;continue;}byID.set(id,item);}
  for(const item of items) {
    if(!byID.has(item?.FolderId?.Id)||item.FolderClass!=='IPF.Note')continue;
    if(!['true','false'].includes(hidden(item))){qualified=false;continue;}
    if(hidden(item)==='true'||excluded.has(item.DistinguishedFolderId))continue;
    if(item.DistinguishedFolderId&&!['inbox','archive'].includes(item.DistinguishedFolderId)){qualified=false;continue;}
    let parent=item.ParentFolderId?.Id,skip=false;const seen=new Set([item.FolderId.Id]);
    while(parent!==root.ParentFolder?.FolderId?.Id) {
      const ancestor=byID.get(parent);
      if(!ancestor||seen.has(parent)){qualified=false;skip=true;break;}
      seen.add(parent);
      if(excluded.has(ancestor.DistinguishedFolderId)||hidden(ancestor)==='true'){skip=true;break;}
      parent=ancestor.ParentFolderId?.Id;
    }
    if(skip)continue;
    if(typeof item.DisplayName!=='string'||!item.DisplayName||item.DisplayName.length>256){qualified=false;continue;}
    folders.push({id:item.FolderId.Id,name:item.DisplayName,inbox:item.DistinguishedFolderId==='inbox'});
  }
  folders.sort((a,b)=>Number(b.inbox)-Number(a.inbox)||a.id.localeCompare(b.id));
  if(folders.length>100||!folders.some(folder=>folder.inbox&&folder.id===inboxID))qualified=false;
  return {account:owner.toLowerCase(),id:inboxID,folders:folders.slice(0,100),qualified};
}
