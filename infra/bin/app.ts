#!/usr/bin/env node
import { App, RemovalPolicy } from 'aws-cdk-lib';
import { RetailStack, repoPath } from '../lib/retail-stack';

const app = new App();
const ctx = (k: string) => app.node.tryGetContext(k) ?? process.env[`SROS_${k.toUpperCase()}`];

new RetailStack(app, 'SmartRetailOS', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1' },
  alertEmail: ctx('alertEmail') || undefined,
  monthlyBudgetUsd: Number(ctx('budgetUsd') ?? 10),
  bedrockModelId: ctx('bedrockModelId') || undefined,
  signerAssetPath: ctx('signerAsset') ?? repoPath('ledger', 'target', 'lambda', 'ledger-signer'),
  backendSrcPath: repoPath('backend', 'src'),
  mlPath: repoPath('ml'),
  dataRemovalPolicy: ctx('demo') === 'true' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
});
