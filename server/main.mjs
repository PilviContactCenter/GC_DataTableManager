import { createColumnPolicyServer } from './column-policy.mjs';

try {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = await createColumnPolicyServer();
  server.on('error', () => { console.error('Policy service failed'); process.exit(1); });
  server.listen(port, '0.0.0.0', () => console.log(`Column policy service listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
} catch {
  console.error('Policy service startup failed: check configuration and storage');
  process.exitCode = 1;
}
