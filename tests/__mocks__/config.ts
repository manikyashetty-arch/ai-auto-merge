export const config = {
  github: {
    appId: 12345,
    privateKey: 'test-private-key',
    webhookSecret: 'test-webhook-secret',
  },
  llm: {
    provider: 'anthropic' as const,
    resolutionMode: 'adaptive' as const,
  },
  anthropic: {
    apiKey: 'test-anthropic-key',
    model: 'claude-opus-4-8',
    judgeModel: 'claude-haiku-4-5',
    effort: 'medium' as const,
  },
  openai: {
    apiKey: '',
    model: 'gpt-4o',
    judgeModel: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  server: {
    port: 3000,
    nodeEnv: 'test',
    dashboardToken: '',
    rateLimitPerMinute: 300,
    trustProxy: false,
  },
  settings: {
    autoMergeOnCIPass: false,
    autoMergeMethod: 'SQUASH' as const,
    autoApplyConfidenceThreshold: 'high' as const,
    maxFilesToAutoResolve: 20,
    maxFileBytes: 262_144,
    queueConcurrency: 3,
    inProcessConcurrency: 2,
  },
  learning: {
    enabled: true,
    minSamples: 5,
    overrideThreshold: 0.5,
  },
  notifications: {
    slackWebhookUrl: '',
    genericWebhookUrl: '',
    onlyOutcomes: [] as string[],
  },
};
