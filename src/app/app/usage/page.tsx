import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ESTIMATED_PRICES } from "@/lib/ops/usage";
import { getWorkspaceUsage } from "@/lib/ops/usage-service";

export const dynamic="force-dynamic";

function usd(value:number|null){
  return value===null?"unpriced":"$"+value.toFixed(value<1&&value>0?4:2);
}

function bytes(value:number){
  const units=["B","KB","MB","GB","TB"];
  let size=value;
  let unit=0;
  while(size>=1024&&unit<units.length-1){size/=1024;unit++;}
  return size.toFixed(unit?1:0)+" "+units[unit];
}

function quotaValue(key:string,value:number|null){
  if(value===null) return "not set";
  if(key==="monthlyBudgetUsd") return usd(value);
  if(key==="storageBytesLimit") return bytes(value);
  return String(value);
}

export default async function UsagePage(){
  const session=await auth.api.getSession({headers:await headers()});
  if(!session) redirect("/sign-in");
  const usage=await getWorkspaceUsage({userId:session.user.id,displayName:session.user.name});

  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">{usage.workspace.name}</p>
          <h1 className="dashboardTitle">Usage, cost and quotas</h1>
        </div>
        <div className="headerActions">
          <Link className="secondaryButton linkButton" href="/app">Back to studio</Link>
        </div>
      </header>

      <section className="dashboardCard">
        <p className="dashboardNote">
          Costs are <strong>estimates</strong> from published list prices for successful paid-provider jobs.
          Providers do not report billed amounts back to this app; check each provider&apos;s dashboard for invoices.
          Local analysis, FFmpeg rendering, ComfyUI/Mac/browser GPU and imports are $0.
        </p>
      </section>

      <section className="projectSection" aria-labelledby="quota-heading">
        <div className="sectionHeading"><h2 id="quota-heading">Quotas</h2></div>
        <table className="usageTable">
          <thead><tr><th scope="col">Quota</th><th scope="col">Used</th><th scope="col">Limit</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {usage.quotas.map(item=>(
              <tr key={item.key}>
                <th scope="row">{item.label}</th>
                <td>{quotaValue(item.key,item.used)}</td>
                <td>{quotaValue(item.key,item.limit)}</td>
                <td>{item.state==="unset"?"No limit configured":item.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dashboardNote">
          Set USAGE_MONTHLY_BUDGET_USD, USAGE_MONTHLY_JOB_LIMIT or USAGE_STORAGE_LIMIT_BYTES on the server to track limits.
          Quotas are reported here and are not enforced automatically.
        </p>
      </section>

      <section className="projectSection" aria-labelledby="history-heading">
        <div className="sectionHeading"><h2 id="history-heading">Monthly history</h2><span>since {usage.since.slice(0,10)}</span></div>
        {usage.months.length===0?<p className="dashboardNote">No generation jobs yet.</p>:(
          <table className="usageTable">
            <thead><tr><th scope="col">Month (UTC)</th><th scope="col">Jobs</th><th scope="col">Succeeded</th><th scope="col">Failed</th><th scope="col">Paid-provider jobs</th><th scope="col">Est. cost</th><th scope="col">Compute</th></tr></thead>
            <tbody>
              {usage.months.map(month=>(
                <tr key={month.month}>
                  <th scope="row">{month.month}</th>
                  <td>{month.jobs}</td>
                  <td>{month.succeeded}</td>
                  <td>{month.failed}</td>
                  <td>{month.paidJobs}</td>
                  <td>{usd(month.estimatedUsd)}{month.unpricedJobs?" + "+month.unpricedJobs+" unpriced":""}</td>
                  <td>{Math.round(month.computeSeconds/60)} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="projectSection" aria-labelledby="provider-heading">
        <div className="sectionHeading"><h2 id="provider-heading">By provider</h2></div>
        <table className="usageTable">
          <thead><tr><th scope="col">Provider</th><th scope="col">Kind</th><th scope="col">Jobs</th><th scope="col">Succeeded</th><th scope="col">Est. cost</th><th scope="col">Price basis</th></tr></thead>
          <tbody>
            {usage.providers.map(item=>(
              <tr key={item.providerKey+item.kind}>
                <th scope="row">{item.providerKey}</th>
                <td>{item.kind}</td>
                <td>{item.jobs}</td>
                <td>{item.succeeded}</td>
                <td>{usd(item.estimatedUsd)}</td>
                <td>{item.priceLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dashboardNote">
          Price table: {Object.entries(ESTIMATED_PRICES).map(([key,price])=>key+" "+price.label).join(" · ")}.
        </p>
      </section>

      <section className="projectSection" aria-labelledby="storage-heading">
        <div className="sectionHeading"><h2 id="storage-heading">Storage</h2></div>
        <p className="dashboardValue">{bytes(usage.storage.bytes)} in {usage.storage.files} media version(s)</p>
      </section>

      <section className="projectSection" aria-labelledby="recent-heading">
        <div className="sectionHeading"><h2 id="recent-heading">Recent jobs</h2></div>
        <table className="usageTable">
          <thead><tr><th scope="col">When</th><th scope="col">Project</th><th scope="col">Kind</th><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Est. cost</th></tr></thead>
          <tbody>
            {usage.recent.map(job=>(
              <tr key={job.id}>
                <td>{job.createdAt.replace("T"," ").slice(0,16)}</td>
                <td>{job.project?<Link href={`/app/projects/${job.project.id}`}>{job.project.title}</Link>:"—"}</td>
                <td>{job.kind}</td>
                <td>{job.providerKey}</td>
                <td>{job.status}</td>
                <td>{usd(job.estimatedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
