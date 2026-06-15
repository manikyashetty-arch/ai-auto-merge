// Set required env vars before any module is imported. Setting them here (a
// setupFile, which runs first) also means a developer's local .env never leaks
// into the test run — dotenv does not override already-set vars.
process.env.LLM_PROVIDER = 'anthropic';
process.env.GITHUB_APP_ID = '12345';
process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.ANTHROPIC_API_KEY = 'test-api-key';
delete process.env.OPENAI_API_KEY;
