-- backend/migrations/028_add_unique_key_to_revisions_contract.sql
-- Add unique key on (id, contract_id) to api_contract_revisions for composite FK reference

ALTER TABLE api_contract_revisions
  ADD UNIQUE KEY uk_revisions_id_contract (id, contract_id);

