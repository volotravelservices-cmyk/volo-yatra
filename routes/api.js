const router = require('express').Router();
const db = require('../db');
const { auth, adminOnly } = require('./middleware');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

// ── helpers ──────────────────────────────────────────────────────────────────
async function nextJE(client) {
  const r = await (client||db).query('SELECT COUNT(*) FROM journal_entries');
  return `JE-${2000+parseInt(r.rows[0].count)+1}`;
}
async function nextInv(client, svc) {
  const r = await client.query('SELECT * FROM invoice_sequences WHERE service_type=$1', [svc]);
  if (!r.rows.length) return `VY/INV/26-27/${Date.now()}`;
  const n = (r.rows[0].last_number||0)+1;
  await client.query('UPDATE invoice_sequences SET last_number=$1 WHERE service_type=$2', [n, svc]);
  return `${r.rows[0].prefix}/${String(n).padStart(4,'0')}`;
}
function guessLedger(desc) {
  const d=(desc||'').toLowerCase();
  const r=[
    {k:['salary','salari','payroll','wages'],l:'Salaries & Wages'},
    {k:['rent','office rent'],l:'Office Rent'},
    {k:['indigo','spicejet','airindia','vistara','goair','akasa','airline','airfare'],l:'Airfare Purchase'},
    {k:['hotel','oyo','treebo'],l:'Hotel Purchase'},
    {k:['irctc','railway'],l:'Train Ticketing Revenue'},
    {k:['visa fee','embassy','vfs','bls'],l:'Visa Service Revenue'},
    {k:['makemytrip','mmt','goibibo','yatra'],l:'Air Ticketing Revenue'},
    {k:['bank charge','bank fee','sms','annual fee','atm charge','chgs'],l:'Bank Charges'},
    {k:['jio','airtel','bsnl','internet','broadband'],l:'Telephone & Internet'},
    {k:['petrol','fuel','diesel'],l:'Fuel Expense'},
    {k:['cash withdrawal','atm'],l:'Cash in Hand'},
    {k:['interest earned','int cr'],l:'Interest Income'},
    {k:['facebook','google ads','advertisement'],l:'Advertisement Expense'},
  ];
  for(const x of r){if(x.k.some(k=>d.includes(k)))return x.l;}
  return '';
}
function parseDateStr(s) {
  if(!s)return null; s=s.trim();
  let m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if(m)return `20${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  const mn={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  m=s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/i);
  if(m&&mn[m[2].toLowerCase()])return `${m[3]}-${mn[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
  return null;
}
function audit(uid,uname,action,module,ref){
  db.query('INSERT INTO audit_log (user_id,user_name,action,module,record_ref) VALUES ($1,$2,$3,$4,$5)',[uid,uname,action,module,ref]).catch(()=>{});
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', auth, async (req,res) => {
  try {
    const [rev,bk,inv,ld,bd,rb] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM bookings WHERE EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW()) AND status!='cancelled'`),
      db.query(`SELECT COUNT(*) as v FROM bookings WHERE status IN ('confirmed','pending','processing')`),
      db.query(`SELECT COALESCE(SUM(total_amount),0) as v, COUNT(*) as c FROM invoices WHERE status IN ('unpaid','overdue')`),
      db.query(`SELECT COUNT(*) as v FROM leads WHERE status='active'`),
      db.query(`SELECT service_type,COUNT(*) as c,COALESCE(SUM(total_amount),0) as r FROM bookings WHERE status!='cancelled' AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW()) GROUP BY service_type ORDER BY r DESC`),
      db.query(`SELECT booking_ref,party_name,service_type,total_amount,status,created_at FROM bookings ORDER BY created_at DESC LIMIT 5`)
    ]);
    res.json({ revenue:parseFloat(rev.rows[0].v), activeBookings:parseInt(bk.rows[0].v), pendingInvAmt:parseFloat(inv.rows[0].v), pendingInvCnt:parseInt(inv.rows[0].c), openLeads:parseInt(ld.rows[0].v), breakdown:bd.rows, recentBookings:rb.rows });
  } catch(e){res.status(500).json({error:e.message});}
});

// ── BOOKINGS ─────────────────────────────────────────────────────────────────
router.get('/bookings', auth, async (req,res) => {
  try {
    const {service_type,status,search,limit=100,offset=0}=req.query;
    let where=['1=1'],params=[],i=1;
    if(service_type){where.push(`service_type=$${i++}`);params.push(service_type);}
    if(status){where.push(`status=$${i++}`);params.push(status);}
    if(search){where.push(`(party_name ILIKE $${i} OR booking_ref ILIKE $${i} OR pnr_ref ILIKE $${i})`);params.push(`%${search}%`);i++;}
    const r=await db.query(`SELECT * FROM bookings WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`,[...params,limit,offset]);
    const c=await db.query(`SELECT COUNT(*) FROM bookings WHERE ${where.join(' AND ')}`,params);
    res.json({bookings:r.rows,total:parseInt(c.rows[0].count)});
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/bookings', auth, async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const {service_type,party_name,pnr_ref,route_from,route_to,travel_date,return_date,passengers,gross_fare,service_fee,total_amount,cost_price,vendor,data_source,status,notes}=req.body;
    const c=await client.query('SELECT COUNT(*) FROM bookings');
    const ref=`VY-${3000+parseInt(c.rows[0].count)}`;
    const profit=(parseFloat(total_amount)||0)-(parseFloat(cost_price)||0);
    const r=await client.query(
      `INSERT INTO bookings (booking_ref,service_type,party_name,pnr_ref,route_from,route_to,travel_date,return_date,passengers,gross_fare,service_fee,total_amount,cost_price,profit,vendor,data_source,status,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [ref,service_type,party_name,pnr_ref,route_from,route_to,travel_date||null,return_date||null,passengers||1,gross_fare||0,service_fee||0,total_amount||0,cost_price||0,profit,vendor,data_source||'manual',status||'pending',notes,req.user.id]
    );
    await client.query('COMMIT');
    audit(req.user.id,req.user.name,'Created booking',service_type,ref);
    res.json({success:true,booking:r.rows[0]});
  } catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}
  finally{client.release();}
});

router.put('/bookings/:id', auth, async (req,res) => {
  try {
    const {status,notes,service_fee,total_amount,pnr_ref,vendor}=req.body;
    const r=await db.query(`UPDATE bookings SET status=COALESCE($1,status),notes=COALESCE($2,notes),service_fee=COALESCE($3,service_fee),total_amount=COALESCE($4,total_amount),pnr_ref=COALESCE($5,pnr_ref),vendor=COALESCE($6,vendor),updated_at=NOW() WHERE id=$7 RETURNING *`,[status,notes,service_fee,total_amount,pnr_ref,vendor,req.params.id]);
    res.json({success:true,booking:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── PARTIES ───────────────────────────────────────────────────────────────────
router.get('/parties', auth, async (req,res) => {
  try {
    const {search}=req.query;
    const r=search
      ? await db.query('SELECT * FROM parties WHERE name ILIKE $1 OR gstin ILIKE $1 ORDER BY name',[`%${search}%`])
      : await db.query('SELECT * FROM parties ORDER BY name');
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/parties', auth, async (req,res) => {
  try {
    const {name,gstin,pan,address,city,state,pin,phone,email,contact_person,is_gst_registered,opening_balance}=req.body;
    const r=await db.query(`INSERT INTO parties (name,gstin,pan,address,city,state,pin,phone,email,contact_person,is_gst_registered,opening_balance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[name,gstin||null,pan||null,address,city,state,pin,phone,email,contact_person,is_gst_registered||false,opening_balance||0]);
    res.json({success:true,party:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

router.put('/parties/:id', auth, async (req,res) => {
  try {
    const {name,gstin,pan,address,city,state,pin,phone,email,contact_person,is_gst_registered}=req.body;
    const r=await db.query(`UPDATE parties SET name=COALESCE($1,name),gstin=$2,pan=$3,address=COALESCE($4,address),city=COALESCE($5,city),state=COALESCE($6,state),pin=COALESCE($7,pin),phone=COALESCE($8,phone),email=COALESCE($9,email),contact_person=COALESCE($10,contact_person),is_gst_registered=COALESCE($11,is_gst_registered) WHERE id=$12 RETURNING *`,[name,gstin||null,pan||null,address,city,state,pin,phone,email,contact_person,is_gst_registered,req.params.id]);
    res.json({success:true,party:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── INVOICES ─────────────────────────────────────────────────────────────────
router.get('/invoices', auth, async (req,res) => {
  try {
    const {status,search}=req.query;
    let where=['1=1'],params=[],i=1;
    if(status){where.push(`status=$${i++}`);params.push(status);}
    if(search){where.push(`(invoice_number ILIKE $${i} OR party_name ILIKE $${i})`);params.push(`%${search}%`);i++;}
    const r=await db.query(`SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,params);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/invoices', auth, async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const {booking_id,service_type,invoice_type,party_name,party_gstin,party_address,invoice_date,due_date,gross_fare,taxable_amount,cgst_rate,sgst_rate,igst_rate,hsn_sac,notes}=req.body;
    if(!party_name)throw new Error('Party name is required');
    const svc=service_type||'air';
    const grossF=parseFloat(gross_fare)||0;
    const taxable=parseFloat(taxable_amount)||0;
    const cgst=parseFloat(cgst_rate)||9;
    const sgst=parseFloat(sgst_rate)||9;
    const igst=parseFloat(igst_rate)||0;
    const cgstA=taxable*cgst/100;
    const sgstA=taxable*sgst/100;
    const igstA=taxable*igst/100;
    const total=grossF+taxable+cgstA+sgstA+igstA;
    const invNum=await nextInv(client,svc);
    const r=await client.query(
      `INSERT INTO invoices (invoice_number,invoice_type,booking_id,service_type,party_name,party_gstin,party_address,invoice_date,due_date,gross_fare,taxable_amount,cgst_rate,cgst_amount,sgst_rate,sgst_amount,igst_rate,igst_amount,total_amount,hsn_sac,status,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'unpaid',$20,$21) RETURNING *`,
      [invNum,invoice_type||'tax_invoice',booking_id||null,svc,party_name,party_gstin||null,party_address||null,invoice_date||new Date().toISOString().slice(0,10),due_date||null,grossF,taxable,cgst,cgstA,sgst,sgstA,igst,igstA,total,hsn_sac||'9983',notes||null,req.user.id]
    );
    // Auto journal
    const jeRef=await nextJE(client);
    const je=await client.query(`INSERT INTO journal_entries (entry_number,entry_date,voucher_type,narration,is_auto,created_by) VALUES ($1,NOW(),'Sales',$2,true,$3) RETURNING id`,[jeRef,`Invoice ${invNum} — ${party_name}`,req.user.id]);
    const eid=je.rows[0].id;
    await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,$3,0)`,[eid,party_name,total]);
    await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,0,$3)`,[eid,`${svc.charAt(0).toUpperCase()+svc.slice(1)} Revenue`,taxable]);
    if(cgstA>0)await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,'CGST Payable',0,$2)`,[eid,cgstA]);
    if(sgstA>0)await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,'SGST Payable',0,$2)`,[eid,sgstA]);
    await client.query('COMMIT');
    audit(req.user.id,req.user.name,'Generated invoice','invoicing',invNum);
    res.json({success:true,invoice:r.rows[0]});
  } catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}
  finally{client.release();}
});

router.put('/invoices/:id/mark-paid', auth, async (req,res) => {
  try {
    const {amount,payment_mode,reference_number}=req.body;
    const inv=await db.query('SELECT * FROM invoices WHERE id=$1',[req.params.id]);
    if(!inv.rows.length)return res.status(404).json({error:'Not found'});
    await db.query('UPDATE invoices SET status=$1 WHERE id=$2',['paid',req.params.id]);
    await db.query(`INSERT INTO payments (payment_date,invoice_id,amount,payment_mode,reference_number,created_by) VALUES (NOW(),$1,$2,$3,$4,$5)`,[req.params.id,amount||inv.rows[0].total_amount,payment_mode||'NEFT',reference_number||null,req.user.id]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/credit-notes', auth, async (req,res) => {
  try {
    const {original_invoice_id,booking_id,amount,reason}=req.body;
    const c=await db.query('SELECT COUNT(*) FROM credit_notes');
    const cn=`VY/CN/26-27/${String(parseInt(c.rows[0].count)+1).padStart(4,'0')}`;
    const r=await db.query(`INSERT INTO credit_notes (credit_note_number,original_invoice_id,booking_id,amount,reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[cn,original_invoice_id||null,booking_id||null,amount,reason]);
    if(original_invoice_id)await db.query(`UPDATE invoices SET status='cancelled' WHERE id=$1`,[original_invoice_id]);
    res.json({success:true,credit_note:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── ACCOUNTING ─────────────────────────────────────────────────────────────────
router.get('/accounting/summary', auth, async (req,res) => {
  try {
    const [rev,gst,debt]=await Promise.all([
      db.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM invoices WHERE status!='cancelled'`),
      db.query(`SELECT COALESCE(SUM(cgst_amount+sgst_amount+igst_amount),0) as v FROM invoices WHERE status!='cancelled' AND EXTRACT(MONTH FROM invoice_date)=EXTRACT(MONTH FROM NOW())`),
      db.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM invoices WHERE status IN ('unpaid','overdue')`)
    ]);
    res.json({ytdRevenue:parseFloat(rev.rows[0].v),gstLiability:parseFloat(gst.rows[0].v),debtors:parseFloat(debt.rows[0].v)});
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/accounting/ledgers', auth, async (req,res) => {
  try {
    const l=await db.query('SELECT * FROM ledgers ORDER BY ledger_group,name');
    const p=await db.query('SELECT name FROM parties ORDER BY name LIMIT 200');
    res.json([...l.rows,...p.rows.map(x=>({name:x.name,ledger_group:'Parties / Clients',ledger_type:'party'}))]);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/accounting/journal-entries', auth, async (req,res) => {
  try {
    const r=await db.query('SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/accounting/journal-entries', auth, async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const {voucher_type,entry_date,narration,lines}=req.body;
    if(!lines||!lines.length)throw new Error('No lines provided');
    const totalDr=lines.reduce((s,l)=>s+(parseFloat(l.debit)||0),0);
    const totalCr=lines.reduce((s,l)=>s+(parseFloat(l.credit)||0),0);
    if(Math.abs(totalDr-totalCr)>0.01)throw new Error(`Entry not balanced — Debit ₹${totalDr.toFixed(2)} ≠ Credit ₹${totalCr.toFixed(2)}`);
    const jeRef=await nextJE(client);
    const je=await client.query(`INSERT INTO journal_entries (entry_number,entry_date,voucher_type,narration,is_auto,created_by) VALUES ($1,$2,$3,$4,false,$5) RETURNING id`,[jeRef,entry_date||new Date().toISOString().slice(0,10),voucher_type||'Journal',narration,req.user.id]);
    const eid=je.rows[0].id;
    for(const line of lines){
      const dr=parseFloat(line.debit)||0;
      const cr=parseFloat(line.credit)||0;
      if((dr>0||cr>0)&&line.ledger_name){
        await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,$3,$4)`,[eid,line.ledger_name,dr,cr]);
      }
    }
    await client.query('COMMIT');
    audit(req.user.id,req.user.name,'Posted journal entry','accounting',jeRef);
    res.json({success:true,entry_number:jeRef});
  } catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}
  finally{client.release();}
});

router.get('/accounting/ageing', auth, async (req,res) => {
  try {
    const r=await db.query(`SELECT party_name, SUM(CASE WHEN NOW()-invoice_date<=INTERVAL '30 days' THEN total_amount ELSE 0 END) as d0, SUM(CASE WHEN NOW()-invoice_date BETWEEN INTERVAL '31 days' AND INTERVAL '60 days' THEN total_amount ELSE 0 END) as d31, SUM(CASE WHEN NOW()-invoice_date>INTERVAL '60 days' THEN total_amount ELSE 0 END) as d60, SUM(total_amount) as total FROM invoices WHERE status IN ('unpaid','overdue') GROUP BY party_name ORDER BY total DESC`);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/accounting/gst-summary', auth, async (req,res) => {
  try {
    const r=await db.query(`SELECT service_type,COALESCE(SUM(taxable_amount),0) as taxable,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount+sgst_amount+igst_amount),0) as total_gst FROM invoices WHERE status!='cancelled' AND EXTRACT(MONTH FROM invoice_date)=EXTRACT(MONTH FROM NOW()) GROUP BY service_type`);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/accounting/party-ledger/:party', auth, async (req,res) => {
  try {
    const {pendingOnly}=req.query;
    let where=`party_name ILIKE $1`,params=[`%${req.params.party}%`];
    if(pendingOnly==='true')where+=` AND status IN ('unpaid','overdue')`;
    const r=await db.query(`SELECT i.*,b.pnr_ref,b.route_from,b.route_to,b.travel_date,b.vendor FROM invoices i LEFT JOIN bookings b ON i.booking_id=b.id WHERE ${where} ORDER BY i.invoice_date`,params);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

// ── BANKING ─────────────────────────────────────────────────────────────────
router.get('/bank/accounts', auth, async (req,res) => {
  try {const r=await db.query('SELECT * FROM bank_accounts WHERE is_active=true ORDER BY account_name');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});

router.post('/bank/accounts', auth, async (req,res) => {
  try {
    const {account_name,bank_name,account_number,ifsc_code,account_type,opening_balance}=req.body;
    if(!account_name||!bank_name)throw new Error('Account name and bank name required');
    const last4=account_number?.slice(-4)||'xxxx';
    const ledger_name=`${bank_name} A/c - ${last4}`;
    await db.query(`INSERT INTO ledgers (name,ledger_group,ledger_type,is_system) VALUES ($1,'Cash & Bank','asset',false) ON CONFLICT DO NOTHING`,[ledger_name]);
    const r=await db.query(`INSERT INTO bank_accounts (account_name,bank_name,account_number,ifsc_code,account_type,opening_balance,current_balance,ledger_name) VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,[account_name,bank_name,account_number,ifsc_code,account_type||'current',opening_balance||0,ledger_name]);
    res.json({success:true,account:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/bank/transactions', auth, async (req,res) => {
  try {
    const {status,bank_account_id}=req.query;
    let where=['1=1'],params=[],i=1;
    if(status&&status!=='all'){where.push(`bt.status=$${i++}`);params.push(status);}
    if(bank_account_id){where.push(`bt.bank_account_id=$${i++}`);params.push(bank_account_id);}
    const r=await db.query(`SELECT bt.*,ba.account_name,ba.bank_name,ba.ledger_name as bank_ledger FROM bank_transactions bt LEFT JOIN bank_accounts ba ON bt.bank_account_id=ba.id WHERE ${where.join(' AND ')} ORDER BY bt.txn_date DESC,bt.id DESC LIMIT 500`,params);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/bank/summary', auth, async (req,res) => {
  try {
    const r=await db.query(`SELECT COUNT(*) FILTER(WHERE status='pending') as pending,COUNT(*) FILTER(WHERE status='posted') as posted,COALESCE(SUM(credit_amount) FILTER(WHERE status='posted'),0) as credits,COALESCE(SUM(debit_amount) FILTER(WHERE status='posted'),0) as debits FROM bank_transactions`);
    res.json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/bank/upload', auth, upload.single('statement'), async (req,res) => {
  if(!req.file)return res.status(400).json({error:'No file uploaded'});
  try {
    let pdf;
    try{pdf=require('pdf-parse');}catch{return res.status(500).json({error:'pdf-parse not installed. Run: npm install pdf-parse'});}
    const data=await pdf(req.file.buffer);
    const lines=data.text.split('\n').map(l=>l.trim()).filter(Boolean);
    const txns=[];
    for(const line of lines){
      const p1=line.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+\w{3}\s+\d{4})\s+(.{3,100}?)\s+([\d,]+\.\d{2})\s*(Dr|Cr)\s+([\d,]+\.\d{2})/i);
      if(p1){const amt=parseFloat(p1[3].replace(/,/g,''));const isCr=p1[4].toLowerCase()==='cr';const bal=parseFloat(p1[5].replace(/,/g,''));txns.push({txn_date:parseDateStr(p1[1]),description:p1[2].trim(),debit_amount:isCr?0:amt,credit_amount:isCr?amt:0,balance:bal,suggested_ledger:guessLedger(p1[2])});continue;}
      const p2=line.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+\w{3}\s+\d{4})\s+(.{3,80}?)\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})\s*$/i);
      if(p2){const dr=p2[3]?parseFloat(p2[3].replace(/,/g,'')):0;const cr=p2[4]?parseFloat(p2[4].replace(/,/g,'')):0;const bal=parseFloat(p2[5].replace(/,/g,''));if(dr>0||cr>0)txns.push({txn_date:parseDateStr(p2[1]),description:p2[2].trim(),debit_amount:dr,credit_amount:cr,balance:bal,suggested_ledger:guessLedger(p2[2])});}
    }
    const valid=txns.filter(t=>t.txn_date&&(t.debit_amount>0||t.credit_amount>0));
    if(!valid.length)return res.status(422).json({error:'Could not extract transactions. Ensure PDF is text-based (not scanned). Supported: HDFC, ICICI, SBI, Axis, Kotak.'});
    const saved=[];
    for(const t of valid){
      try{const r=await db.query(`INSERT INTO bank_transactions (bank_account_id,txn_date,description,debit_amount,credit_amount,balance,suggested_ledger,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,[req.body.bank_account_id||null,t.txn_date,t.description.substring(0,200),t.debit_amount,t.credit_amount,t.balance||0,t.suggested_ledger||'']);saved.push(r.rows[0]);}catch(e){}
    }
    res.json({success:true,parsed:valid.length,saved:saved.length,transactions:saved});
  } catch(e){res.status(500).json({error:'Parse error: '+e.message});}
});

router.post('/bank/transactions/:id/post', auth, async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const {ledger_name,narration,bank_ledger}=req.body;
    if(!ledger_name)throw new Error('Select a ledger first');
    const txRes=await client.query('SELECT bt.*,ba.ledger_name as bank_ledger_name FROM bank_transactions bt LEFT JOIN bank_accounts ba ON bt.bank_account_id=ba.id WHERE bt.id=$1',[req.params.id]);
    if(!txRes.rows.length)throw new Error('Transaction not found');
    const tx=txRes.rows[0];
    if(tx.status==='posted')throw new Error('Already posted');
    const bLed=bank_ledger||tx.bank_ledger_name||'HDFC Bank A/c';
    const jeRef=await nextJE(client);
    const je=await client.query(`INSERT INTO journal_entries (entry_number,entry_date,voucher_type,narration,is_auto,created_by) VALUES ($1,$2,'Bank',$3,false,$4) RETURNING id`,[jeRef,tx.txn_date,narration||tx.description,req.user.id]);
    const eid=je.rows[0].id;
    if(parseFloat(tx.credit_amount)>0){
      await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,$3,0)`,[eid,bLed,tx.credit_amount]);
      await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,0,$3)`,[eid,ledger_name,tx.credit_amount]);
    } else {
      await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,$3,0)`,[eid,ledger_name,tx.debit_amount]);
      await client.query(`INSERT INTO journal_lines (entry_id,ledger_name,debit_amount,credit_amount) VALUES ($1,$2,0,$3)`,[eid,bLed,tx.debit_amount]);
    }
    await client.query(`UPDATE bank_transactions SET status='posted',suggested_ledger=$1,journal_entry_id=$2 WHERE id=$3`,[ledger_name,eid,req.params.id]);
    await client.query('COMMIT');
    res.json({success:true,entry_number:jeRef});
  } catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}
  finally{client.release();}
});

router.post('/bank/transactions/:id/ignore', auth, async (req,res) => {
  try{await db.query(`UPDATE bank_transactions SET status='ignored' WHERE id=$1`,[req.params.id]);res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});

// ── WALLETS ─────────────────────────────────────────────────────────────────
router.get('/wallets', auth, async (req,res) => {
  try{const r=await db.query('SELECT * FROM portal_wallets WHERE is_active=true ORDER BY portal_name');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});
router.put('/wallets/:id', auth, async (req,res) => {
  try{const {balance}=req.body;const r=await db.query('UPDATE portal_wallets SET balance=$1,last_updated=NOW() WHERE id=$2 RETURNING *',[balance,req.params.id]);res.json({success:true,wallet:r.rows[0]});}
  catch(e){res.status(500).json({error:e.message});}
});

// ── LEADS ─────────────────────────────────────────────────────────────────────
router.get('/leads', auth, async (req,res) => {
  try {
    const {stage,status='active'}=req.query;
    let where=[`status=$1`],params=[status],i=2;
    if(stage){where.push(`pipeline_stage=$${i++}`);params.push(stage);}
    const r=await db.query(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,params);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});
router.post('/leads', auth, async (req,res) => {
  try {
    const {name,company,phone,email,source,service_interest,destination,travel_date,passengers,estimated_value,notes}=req.body;
    const r=await db.query(`INSERT INTO leads (name,company,phone,email,source,service_interest,destination,travel_date,passengers,estimated_value,notes,follow_up_date,assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '2 days',$12) RETURNING *`,[name,company,phone,email,source,service_interest,destination,travel_date||null,passengers||1,estimated_value||0,notes,req.user.id]);
    res.json({success:true,lead:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});
router.put('/leads/:id', auth, async (req,res) => {
  try {
    const {pipeline_stage,notes,status,follow_up_date,estimated_value}=req.body;
    const r=await db.query(`UPDATE leads SET pipeline_stage=COALESCE($1,pipeline_stage),notes=COALESCE($2,notes),status=COALESCE($3,status),follow_up_date=COALESCE($4,follow_up_date),estimated_value=COALESCE($5,estimated_value),updated_at=NOW() WHERE id=$6 RETURNING *`,[pipeline_stage,notes,status,follow_up_date,estimated_value,req.params.id]);
    res.json({success:true,lead:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
router.get('/campaigns', auth, async (req,res) => {
  try{const r=await db.query('SELECT * FROM campaigns ORDER BY created_at DESC');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});
router.post('/campaigns', auth, async (req,res) => {
  try{const {name,channel,start_date,end_date,budget}=req.body;const r=await db.query(`INSERT INTO campaigns (name,channel,start_date,end_date,budget) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[name,channel,start_date,end_date,budget||0]);res.json({success:true,campaign:r.rows[0]});}
  catch(e){res.status(500).json({error:e.message});}
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
router.get('/analytics/revenue', auth, async (req,res) => {
  try{const r=await db.query(`SELECT TO_CHAR(invoice_date,'Mon YYYY') as month,DATE_TRUNC('month',invoice_date) as md,COALESCE(SUM(total_amount),0) as revenue,COUNT(*) as count FROM invoices WHERE status!='cancelled' GROUP BY month,md ORDER BY md DESC LIMIT 12`);res.json(r.rows.reverse());}
  catch(e){res.status(500).json({error:e.message});}
});
router.get('/analytics/destinations', auth, async (req,res) => {
  try{const r=await db.query(`SELECT route_to as destination,COUNT(*) as count,COALESCE(SUM(total_amount),0) as revenue FROM bookings WHERE status!='cancelled' AND route_to IS NOT NULL GROUP BY route_to ORDER BY count DESC LIMIT 10`);res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});

// ── USERS ─────────────────────────────────────────────────────────────────────
router.get('/users', auth, adminOnly, async (req,res) => {
  try{const r=await db.query('SELECT id,name,email,role,permissions,access_until,is_active,last_login,created_at FROM users ORDER BY name');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});
router.post('/users', auth, adminOnly, async (req,res) => {
  try {
    const {name,email,password,role,permissions,access_until}=req.body;
    if(!name||!email||!password)return res.status(400).json({error:'Name, email and password required'});
    const hash=await bcrypt.hash(password,10);
    const r=await db.query(`INSERT INTO users (name,email,password_hash,role,permissions,access_until) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,permissions,is_active`,[name,email,hash,role||'staff',permissions||'bookings,crm',access_until||null]);
    res.json({success:true,user:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});
router.put('/users/:id', auth, adminOnly, async (req,res) => {
  try {
    const {name,email,password,role,permissions,access_until,is_active}=req.body;
    if(password&&password.trim()){
      const hash=await bcrypt.hash(password.trim(),10);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,req.params.id]);
    }
    const r=await db.query(`UPDATE users SET name=COALESCE($1,name),email=COALESCE($2,email),role=COALESCE($3,role),permissions=COALESCE($4,permissions),access_until=$5,is_active=COALESCE($6,is_active) WHERE id=$7 RETURNING id,name,email,role,permissions,is_active,access_until`,[name,email,role,permissions,access_until||null,is_active,req.params.id]);
    res.json({success:true,user:r.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
router.get('/settings/company', auth, async (req,res) => {
  try{const r=await db.query('SELECT * FROM company_settings LIMIT 1');res.json(r.rows[0]||{});}
  catch(e){res.status(500).json({error:e.message});}
});
router.put('/settings/company', auth, adminOnly, async (req,res) => {
  try {
    const {company_name,gstin,pan,address,city,state,state_code,pin,phone,email,website,bank_name,bank_account,bank_ifsc}=req.body;
    const ex=await db.query('SELECT id FROM company_settings LIMIT 1');
    if(ex.rows.length){await db.query(`UPDATE company_settings SET company_name=$1,gstin=$2,pan=$3,address=$4,city=$5,state=$6,state_code=$7,pin=$8,phone=$9,email=$10,website=$11,bank_name=$12,bank_account=$13,bank_ifsc=$14 WHERE id=$15`,[company_name,gstin,pan,address,city,state,state_code,pin,phone,email,website,bank_name,bank_account,bank_ifsc,ex.rows[0].id]);}
    else{await db.query(`INSERT INTO company_settings (company_name,gstin,pan,address,city,state,state_code,pin,phone,email,website,bank_name,bank_account,bank_ifsc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[company_name,gstin,pan,address,city,state,state_code,pin,phone,email,website,bank_name,bank_account,bank_ifsc]);}
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});
router.get('/settings/gst', auth, async (req,res) => {
  try{const r=await db.query('SELECT * FROM gst_config ORDER BY service_type');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});
router.put('/settings/gst/:svc', auth, adminOnly, async (req,res) => {
  try{const {cgst_rate,sgst_rate,igst_rate,is_applicable}=req.body;await db.query(`UPDATE gst_config SET cgst_rate=$1,sgst_rate=$2,igst_rate=$3,is_applicable=$4 WHERE service_type=$5`,[cgst_rate,sgst_rate,igst_rate,is_applicable,req.params.svc]);res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});
router.get('/audit-log', auth, adminOnly, async (req,res) => {
  try{const r=await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');res.json(r.rows);}
  catch(e){res.status(500).json({error:e.message});}
});

// ── TEMPLATES ─────────────────────────────────────────────────────────────────
router.get('/templates/:type', auth, (req,res) => {
  const tpl={
    bookings:{h:['service_type','party_name','gstin','phone','pnr_ref','route_from','route_to','travel_date','return_date','passengers','gross_fare','service_fee','total_amount','cost_price','vendor','status','notes'],s:[['air','Mehta Travels Pvt Ltd','22AAAAB5678D2Z1','+91 98765 43210','TZMX4A','DEL','BOM','2026-05-01','2026-05-08',4,118000,6000,124000,112000,'IndiGo','confirmed','Sample row']]},
    parties:{h:['name','gstin','pan','address','city','state','pin','phone','email','contact_person','is_gst_registered','opening_balance'],s:[['Mehta Travels Pvt Ltd','22AAAAB5678D2Z1','AAAAB5678D','12 Marine Lines','Mumbai','Maharashtra','400001','+91 98765 43210','mehta@ex.com','Ramesh','TRUE',0]]},
    leads:{h:['name','company','phone','email','source','service_interest','destination','travel_date','passengers','estimated_value','pipeline_stage','notes'],s:[['Kulkarni Family','','+91 98765 77777','','instagram','tour','Europe 12N','2026-07-01',4,320000,'new','Sample']]},
    accounting:{h:['entry_date','voucher_type','narration','debit_account','debit_amount','credit_account','credit_amount'],s:[['2026-04-01','Journal','Opening balance Cash','Cash in Hand',85000,'Capital Account',85000]]}
  };
  const t=tpl[req.params.type];
  if(!t)return res.status(404).json({error:'Unknown template'});
  const esc=v=>{const s=String(v||'');return s.includes(',')||s.includes('"')?`"${s.replace(/"/g,'""')}"`:`${s}`;};
  const csv=[t.h,...t.s].map(r=>r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="VY_${req.params.type}_template.csv"`);
  res.send('\uFEFF'+csv);
});

module.exports = router;
