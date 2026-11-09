-- 039_microsoft_oauth_settings.sql
-- Initialize Microsoft 365 OAuth 2.0 configuration keys in org_settings
INSERT INTO org_settings (key, value, updated_at, updated_by)
VALUES
  ('email_delivery_method', 'smtp', 0, 'system'),
  ('email_oauth_client_id', '', 0, 'system'),
  ('email_oauth_client_secret', '', 0, 'system'),
  ('email_oauth_tenant_id', 'common', 0, 'system'),
  ('email_oauth_refresh_token', '', 0, 'system'),
  ('email_oauth_access_token', '', 0, 'system'),
  ('email_oauth_token_expiry', '0', 0, 'system'),
  ('email_oauth_account_email', '', 0, 'system'),
  ('email_oauth_account_name', '', 0, 'system')
ON CONFLICT (key) DO NOTHING;
