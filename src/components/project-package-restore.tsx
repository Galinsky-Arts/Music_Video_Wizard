"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

type RestoreReport={
  projectId:string;
  restoredMedia:number;
  audioMasterRestored:boolean;
  missingMedia:Array<{assetVersionId:string;reason:string}>;
  notRestored:string[];
};

/** Upload a .mvwpkg.tar exported from Music Video Wizard to restore it as a new project. */
export function ProjectPackageRestore(){
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [report,setReport]=useState<RestoreReport|null>(null);

  async function restore(file:File){
    setBusy(true);
    setError(null);
    setReport(null);
    try{
      const response=await fetch("/api/project-packages",{
        method:"POST",
        headers:{"content-type":"application/x-tar"},
        body:file
      });
      const body=await response.json() as RestoreReport&{error?:string};
      if(!response.ok) throw new Error(body.error??"Project package restore failed.");
      setReport(body);
      router.refresh();
    }catch(restoreError){
      setError(restoreError instanceof Error?restoreError.message:"Project package restore failed.");
    }finally{
      setBusy(false);
    }
  }

  return (
    <section className="dashboardCard" aria-labelledby="restore-heading">
      <p className="dashboardLabel" id="restore-heading">Restore a project package</p>
      <label className="dashboardNote" htmlFor="project-package-file">
        Choose a .mvwpkg.tar exported from a project. It is restored as a new project; missing media is reported.
      </label>
      <input
        id="project-package-file"
        type="file"
        accept=".tar,application/x-tar"
        disabled={busy}
        onChange={event=>{
          const file=event.target.files?.[0];
          if(file) void restore(file);
          event.target.value="";
        }}
      />
      {busy?<p className="formMessage" aria-live="polite">Restoring package…</p>:null}
      {error?<p className="formMessage" role="alert">{error}</p>:null}
      {report?(
        <div aria-live="polite">
          <p className="formMessage">
            Restored {report.restoredMedia} media file(s)
            {report.audioMasterRestored?" including the audio master":"; the audio master was not restored"}.{" "}
            <Link href={`/app/projects/${report.projectId}`}>Open restored project</Link>
          </p>
          {report.missingMedia.length?(
            <details>
              <summary>{report.missingMedia.length} missing media item(s)</summary>
              <ul>
                {report.missingMedia.map(item=>(
                  <li key={item.assetVersionId}><code>{item.assetVersionId}</code>: {item.reason}</li>
                ))}
              </ul>
            </details>
          ):null}
          {report.notRestored.map(note=><p className="dashboardNote" key={note}>{note}</p>)}
        </div>
      ):null}
    </section>
  );
}
