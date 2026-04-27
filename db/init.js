const db = require('./index');

async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'staff', permissions TEXT DEFAULT 'bookings,crm',
        access_until DATE, is_active BOOLEAN DEFAULT true,
        last_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS parties (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, gstin VARCHAR(20),
        pan VARCHAR(20), address TEXT, city VARCHAR(100), state VARCHAR(100),
        pin VARCHAR(10), phone VARCHAR(20), email VARCHAR(100),
        contact_person VARCHAR(100), is_gst_registered BOOLEAN DEFAULT false,
        opening_balance NUMERIC(12,2) DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY, booking_ref VARCHAR(20) UNIQUE NOT NULL,
        service_type VARCHAR(50) NOT NULL, party_name VARCHAR(200),
        pnr_ref VARCHAR(50), route_from VARCHAR(100), route_to VARCHAR(100),
        travel_date DATE, return_date DATE, passengers INTEGER DEFAULT 1,
        gross_fare NUMERIC(12,2) DEFAULT 0, service_fee NUMERIC(12,2) DEFAULT 0,
        total_amount NUMERIC(12,2) DEFAULT 0, cost_price NUMERIC(12,2) DEFAULT 0,
        profit NUMERIC(12,2) DEFAULT 0, vendor VARCHAR(200),
        data_source VARCHAR(50) DEFAULT 'manual', status VARCHAR(50) DEFAULT 'pending',
        notes TEXT, created_by INTEGER, created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY, invoice_number VARCHAR(50) UNIQUE NOT NULL,
        invoice_type VARCHAR(50) DEFAULT 'tax_invoice',
        booking_id INTEGER, service_type VARCHAR(50),
        party_name VARCHAR(200), party_gstin VARCHAR(20), party_address TEXT,
        invoice_date DATE DEFAULT CURRENT_DATE, due_date DATE,
        gross_fare NUMERIC(12,2) DEFAULT 0,
        taxable_amount NUMERIC(12,2) DEFAULT 0,
        cgst_rate NUMERIC(5,2) DEFAULT 9, cgst_amount NUMERIC(12,2) DEFAULT 0,
        sgst_rate NUMERIC(5,2) DEFAULT 9, sgst_amount NUMERIC(12,2) DEFAULT 0,
        igst_rate NUMERIC(5,2) DEFAULT 0, igst_amount NUMERIC(12,2) DEFAULT 0,
        total_amount NUMERIC(12,2) DEFAULT 0, hsn_sac VARCHAR(20) DEFAULT '9983',
        status VARCHAR(50) DEFAULT 'unpaid', notes TEXT,
        created_by INTEGER, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS credit_notes (
        id SERIAL PRIMARY KEY, credit_note_number VARCHAR(50) UNIQUE NOT NULL,
        original_invoice_id INTEGER, booking_id INTEGER,
        credit_date DATE DEFAULT CURRENT_DATE, amount NUMERIC(12,2) DEFAULT 0,
        reason TEXT, status VARCHAR(50) DEFAULT 'issued', created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ledgers (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL,
        ledger_group VARCHAR(100), ledger_type VARCHAR(50),
        opening_balance NUMERIC(12,2) DEFAULT 0, is_system BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS journal_entries (
        id SERIAL PRIMARY KEY, entry_number VARCHAR(30) UNIQUE NOT NULL,
        entry_date DATE DEFAULT CURRENT_DATE, voucher_type VARCHAR(50) DEFAULT 'Journal',
        narration TEXT, is_auto BOOLEAN DEFAULT false,
        created_by INTEGER, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS journal_lines (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER REFERENCES journal_entries(id) ON DELETE CASCADE,
        ledger_name VARCHAR(200), debit_amount NUMERIC(12,2) DEFAULT 0,
        credit_amount NUMERIC(12,2) DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY, account_name VARCHAR(100), bank_name VARCHAR(100),
        account_number VARCHAR(50), ifsc_code VARCHAR(20),
        account_type VARCHAR(50) DEFAULT 'current',
        opening_balance NUMERIC(12,2) DEFAULT 0,
        current_balance NUMERIC(12,2) DEFAULT 0,
        ledger_name VARCHAR(100), is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bank_transactions (
        id SERIAL PRIMARY KEY,
        bank_account_id INTEGER REFERENCES bank_accounts(id),
        txn_date DATE, description TEXT,
        debit_amount NUMERIC(12,2) DEFAULT 0, credit_amount NUMERIC(12,2) DEFAULT 0,
        balance NUMERIC(12,2) DEFAULT 0, suggested_ledger VARCHAR(200),
        status VARCHAR(30) DEFAULT 'pending',
        journal_entry_id INTEGER REFERENCES journal_entries(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY, payment_date DATE DEFAULT CURRENT_DATE,
        invoice_id INTEGER, booking_id INTEGER,
        amount NUMERIC(12,2) DEFAULT 0, payment_mode VARCHAR(50),
        reference_number VARCHAR(100), created_by INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, company VARCHAR(200),
        phone VARCHAR(20), email VARCHAR(100), source VARCHAR(50),
        service_interest VARCHAR(100), destination TEXT, travel_date DATE,
        passengers INTEGER DEFAULT 1, estimated_value NUMERIC(12,2) DEFAULT 0,
        pipeline_stage VARCHAR(50) DEFAULT 'new', assigned_to INTEGER,
        follow_up_date DATE, notes TEXT, status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY, name VARCHAR(200), channel VARCHAR(50),
        start_date DATE, end_date DATE, budget NUMERIC(10,2) DEFAULT 0,
        reach INTEGER DEFAULT 0, enquiries INTEGER DEFAULT 0,
        conversions INTEGER DEFAULT 0, revenue_generated NUMERIC(12,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS gst_config (
        id SERIAL PRIMARY KEY, service_type VARCHAR(100) UNIQUE,
        hsn_sac VARCHAR(20), cgst_rate NUMERIC(5,2) DEFAULT 9,
        sgst_rate NUMERIC(5,2) DEFAULT 9, igst_rate NUMERIC(5,2) DEFAULT 18,
        is_applicable BOOLEAN DEFAULT true, basis VARCHAR(100)
      );
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        id SERIAL PRIMARY KEY, service_type VARCHAR(50) UNIQUE,
        prefix VARCHAR(30), last_number INTEGER DEFAULT 0, financial_year VARCHAR(10)
      );
      CREATE TABLE IF NOT EXISTS company_settings (
        id SERIAL PRIMARY KEY, company_name VARCHAR(200) DEFAULT 'Volo Yatra',
        gstin VARCHAR(20), pan VARCHAR(20), address TEXT, city VARCHAR(100),
        state VARCHAR(100), state_code VARCHAR(5), pin VARCHAR(10),
        phone VARCHAR(20), email VARCHAR(100), website VARCHAR(200),
        bank_name VARCHAR(100), bank_account VARCHAR(50), bank_ifsc VARCHAR(20)
      );
      CREATE TABLE IF NOT EXISTS portal_wallets (
        id SERIAL PRIMARY KEY, portal_name VARCHAR(100) NOT NULL,
        ledger_name VARCHAR(100), balance NUMERIC(12,2) DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW(), is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY, user_id INTEGER, user_name VARCHAR(100),
        action VARCHAR(200), module VARCHAR(100), record_ref VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed essential data
    await db.query(`
      INSERT INTO users (name,email,password_hash,role,permissions)
      VALUES ('Admin','admin@voloyatra.in','$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi','admin','all')
      ON CONFLICT (email) DO NOTHING;

      INSERT INTO company_settings (company_name,gstin,pan,address,city,state,state_code,pin,phone,email)
      VALUES ('Volo Yatra','06AAAAB1234C1Z5','AAAAB1234C','Sector 12, NIT','Faridabad','Haryana','06','121001','+91 99999 00000','info@voloyatra.in')
      ON CONFLICT DO NOTHING;

      INSERT INTO gst_config (service_type,hsn_sac,cgst_rate,sgst_rate,igst_rate,is_applicable,basis) VALUES
      ('air','9983',9,9,18,true,'On service fee/markup only'),
      ('hotel','9983',9,9,18,true,'On service fee/markup only'),
      ('tour','9985',9,9,18,true,'On total package value'),
      ('visa','9983',9,9,18,true,'On service fee'),
      ('train','9983',0,0,0,false,'Exempt'),
      ('taxi','9964',6,6,12,true,'On total fare'),
      ('bus','9964',6,6,12,true,'On total fare')
      ON CONFLICT (service_type) DO NOTHING;

      INSERT INTO invoice_sequences (service_type,prefix,last_number,financial_year) VALUES
      ('air','VY/AIR/26-27',0,'2026-27'),
      ('hotel','VY/HTL/26-27',0,'2026-27'),
      ('tour','VY/TUR/26-27',0,'2026-27'),
      ('visa','VY/VIS/26-27',0,'2026-27'),
      ('train','VY/TRN/26-27',0,'2026-27'),
      ('taxi','VY/TAX/26-27',0,'2026-27'),
      ('bus','VY/BUS/26-27',0,'2026-27')
      ON CONFLICT (service_type) DO NOTHING;

      INSERT INTO ledgers (name,ledger_group,ledger_type,is_system) VALUES
      ('Cash in Hand','Cash & Bank','asset',true),
      ('HDFC Bank A/c','Cash & Bank','asset',true),
      ('ICICI Bank A/c','Cash & Bank','asset',true),
      ('CGST Payable','Tax Liabilities','liability',true),
      ('SGST Payable','Tax Liabilities','liability',true),
      ('IGST Payable','Tax Liabilities','liability',true),
      ('Air Ticketing Revenue','Revenue','income',true),
      ('Hotel Booking Revenue','Revenue','income',true),
      ('Tour Package Revenue','Revenue','income',true),
      ('Visa Service Revenue','Revenue','income',true),
      ('Train Ticketing Revenue','Revenue','income',true),
      ('Transport Revenue','Revenue','income',true),
      ('Airfare Purchase','Direct Expenses','expense',true),
      ('Hotel Purchase','Direct Expenses','expense',true),
      ('Bank Charges','Indirect Expenses','expense',true),
      ('Salaries & Wages','Indirect Expenses','expense',true),
      ('Office Rent','Indirect Expenses','expense',true),
      ('Office Expenses','Indirect Expenses','expense',true),
      ('Telephone & Internet','Indirect Expenses','expense',true),
      ('Advertisement Expense','Indirect Expenses','expense',true),
      ('Fuel Expense','Indirect Expenses','expense',true),
      ('Capital Account','Capital','capital',true),
      ('MakeMyTrip Wallet','Portal Wallets','asset',true),
      ('Booking.com Wallet','Portal Wallets','asset',true),
      ('Razorpay Wallet','Portal Wallets','asset',true)
      ON CONFLICT DO NOTHING;

      INSERT INTO bank_accounts (account_name,bank_name,account_number,ifsc_code,account_type,opening_balance,current_balance,ledger_name) VALUES
      ('HDFC Current Account','HDFC Bank','XXXX4521','HDFC0001234','current',0,0,'HDFC Bank A/c'),
      ('ICICI Current Account','ICICI Bank','XXXX8832','ICIC0002345','current',0,0,'ICICI Bank A/c'),
      ('Cash','Cash','','','cash',0,0,'Cash in Hand')
      ON CONFLICT DO NOTHING;

      INSERT INTO portal_wallets (portal_name,ledger_name,balance) VALUES
      ('MakeMyTrip','MakeMyTrip Wallet',0),
      ('Booking.com','Booking.com Wallet',0),
      ('Razorpay','Razorpay Wallet',0)
      ON CONFLICT DO NOTHING;
    `);

    console.log('✅ Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

module.exports = initDB;
