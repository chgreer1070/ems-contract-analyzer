import { accessErrorResponse, getPrincipal, requireRole } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) {
      return Response.json({ ok: true, mode: "demo", matters: [] });
    }

    const result = await query<{
      id: string; matter_number: string; customer: string; agreement_title: string; region: string;
      annual_revenue: string; stage: string; risk_level: "Low"|"Medium"|"High"|"Critical"; next_action: string;
      restricted: boolean; status: string;
    }>(
      `select m.id, m.matter_number, c.name as customer, m.agreement_title, m.region,
              m.annual_revenue, m.stage, m.risk_level, m.next_action, m.restricted, m.status
         from matters m
         join customers c on c.id = m.customer_id
        where $1 = 'ADMIN'
           or m.owner_user_id = $2
           or exists (select 1 from matter_members mm where mm.matter_id = m.id and mm.user_id = $2)
           or (m.restricted = false and $1 in ('LAWYER','APPROVER'))
        order by m.updated_at desc
        limit 250`,
      [principal.role, principal.userId]
    );

    return Response.json({
      ok: true,
      mode: "database",
      matters: result.rows.map((row) => ({
        id: row.id,
        matterNumber: row.matter_number,
        customer: row.customer,
        agreement: row.agreement_title,
        region: row.region,
        revenue: Number(row.annual_revenue),
        stage: row.stage,
        risk: row.risk_level,
        nextAction: row.next_action,
        restricted: row.restricted,
        status: row.status
      }))
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"Matters could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireRole(request, "LAWYER");
    if (principal.demo || !databaseConfigured()) {
      return Response.json({ ok: false, error: "Persistent matter creation requires DATABASE_URL and production identity." }, { status: 503 });
    }

    const body = await request.json() as Record<string, unknown>;
    const customer = String(body.customer ?? "").trim();
    const agreement = String(body.agreement ?? "").trim();
    const region = String(body.region ?? "Americas").trim();
    const restricted = body.restricted === true;
    if (!customer || !agreement) {
      return Response.json({ ok: false, error: "Customer and agreement title are required." }, { status: 400 });
    }
    if (customer.length > 200 || agreement.length > 300 || region.length > 100) {
      return Response.json({ ok: false, error: "Customer, agreement title, or region exceeds the supported length." }, { status: 400 });
    }
    const revenue = Number(body.revenue ?? 0);
    if (!Number.isFinite(revenue) || revenue < 0 || revenue > 1_000_000_000_000_000) {
      return Response.json({ ok: false, error: "Annual revenue must be a non-negative number within the supported range." }, { status: 400 });
    }

    const matter = await withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`contracttwin-customer:${customer.toLocaleLowerCase("en-US")}`]);
      let customerId: string;
      const existing = await client.query<{ id: string }>(
        "select id from customers where lower(name) = lower($1) order by created_at asc limit 1",
        [customer]
      );
      if (existing.rows[0]) {
        customerId = existing.rows[0].id;
      } else {
        const inserted = await client.query<{ id: string }>(
          "insert into customers(name) values ($1) returning id",
          [customer]
        );
        customerId = inserted.rows[0].id;
      }

      const matterNumber = `CT-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
      const insertedMatter = await client.query<{
        id: string; matter_number: string; agreement_title: string; region: string; annual_revenue: string;
        stage: string; risk_level: "Low"|"Medium"|"High"|"Critical"; next_action: string; restricted: boolean; status: string;
      }>(
        `insert into matters
          (matter_number, customer_id, agreement_title, region, annual_revenue, owner_user_id, restricted)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, matter_number, agreement_title, region, annual_revenue, stage, risk_level, next_action, restricted, status`,
        [matterNumber, customerId, agreement, region, revenue, principal.userId, restricted]
      );
      await client.query(
        `insert into matter_members(matter_id,user_id,access_level,granted_by)
         values ($1,$2,'EDIT',$2)
         on conflict (matter_id,user_id) do nothing`,
        [insertedMatter.rows[0].id, principal.userId]
      );
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'MATTER_CREATED',$3,'matter',$3,$4::jsonb)`,[principal.userId,principal.name,insertedMatter.rows[0].id,JSON.stringify({matterNumber,customer,restricted})]);
      return { ...insertedMatter.rows[0], customer };
    });

    return Response.json({
      ok: true,
      mode: "database",
      matter: {
        id: matter.id,
        matterNumber: matter.matter_number,
        customer,
        agreement: matter.agreement_title,
        region: matter.region,
        revenue: Number(matter.annual_revenue),
        stage: matter.stage,
        risk: matter.risk_level,
        nextAction: matter.next_action,
        restricted: matter.restricted,
        status: matter.status
      }
    }, { status: 201 });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"The matter could not be created.");
  }
}
