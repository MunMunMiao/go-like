import { SQL } from "bun"

import { requireCurrency, requireIdentifier, type LedgerAccount } from "./payment"

const LedgerSchema = String.raw`
CREATE TABLE ledger_account (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (tenant_id, account_id),
  UNIQUE (tenant_id, account_id, currency)
);

CREATE TABLE ledger_transaction (
  transaction_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference text NOT NULL,
  posted_at timestamptz NOT NULL,
  UNIQUE (transaction_id, tenant_id, currency)
);

CREATE TABLE ledger_posting (
  posting_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  FOREIGN KEY (transaction_id, tenant_id, currency)
    REFERENCES ledger_transaction (transaction_id, tenant_id, currency),
  FOREIGN KEY (tenant_id, account_id, currency)
    REFERENCES ledger_account (tenant_id, account_id, currency)
);

CREATE TABLE idempotency_request (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_payload jsonb NOT NULL,
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  response_payload jsonb NOT NULL,
  transaction_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (transaction_id) REFERENCES ledger_transaction (transaction_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outbox_event (
  event_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transaction (transaction_id),
  subject text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  leased_by text,
  leased_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  published_at timestamptz,
  CHECK ((leased_by IS NULL) = (leased_until IS NULL))
);

CREATE FUNCTION assert_ledger_transaction_balanced(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  posting_count bigint;
  account_count bigint;
  posting_total numeric;
BEGIN
  SELECT count(*), count(DISTINCT account_id), coalesce(sum(amount_minor), 0)
    INTO posting_count, account_count, posting_total
    FROM ledger_posting
   WHERE transaction_id = target;
  IF posting_count < 2 OR account_count < 2 OR posting_total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', target
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_balanced';
  END IF;
END;
$$;

CREATE FUNCTION assert_ledger_transaction_header() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_ledger_transaction_balanced(NEW.transaction_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_ledger_transaction_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_ledger_transaction_balanced(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_balance_header
AFTER INSERT ON ledger_transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_header();

CREATE CONSTRAINT TRIGGER ledger_transaction_balance_posting
AFTER INSERT OR UPDATE OR DELETE ON ledger_posting
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_posting();

CREATE TRIGGER ledger_transaction_immutable
BEFORE UPDATE OR DELETE ON ledger_transaction
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER ledger_posting_immutable
BEFORE UPDATE OR DELETE ON ledger_posting
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
`

/** Installs the PostgreSQL tables, deferred balance checks, and append-only triggers. */
export async function migrateLedger(sql: SQL): Promise<void> {
  await sql.unsafe(LedgerSchema).simple()
}

/** Creates one account used by future postings. */
export async function createLedgerAccount(sql: SQL, account: LedgerAccount): Promise<void> {
  requireIdentifier("tenantId", account.tenantId)
  requireIdentifier("accountId", account.accountId)
  requireCurrency(account.currency)
  await sql`
    INSERT INTO ledger_account (tenant_id, account_id, currency)
    VALUES (${account.tenantId}, ${account.accountId}, ${account.currency})
  `
}
