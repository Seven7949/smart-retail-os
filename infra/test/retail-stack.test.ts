import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, RemovalPolicy } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetailStack, repoPath } from '../lib/retail-stack';

function synth(extra: Partial<ConstructorParameters<typeof RetailStack>[2]> = {}): Template {
  const signerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
  fs.writeFileSync(path.join(signerDir, 'bootstrap'), 'stub');
  const app = new App();
  const stack = new RetailStack(app, 'Test', {
    env: { account: '123456789012', region: 'ap-south-1' },
    signerAssetPath: signerDir,
    backendSrcPath: repoPath('backend', 'src'),
    mlPath: repoPath('ml'),
    alertEmail: 'owner@example.com',
    ...extra,
  });
  return Template.fromStack(stack);
}

const t = synth();
const allStatements = () =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);

describe('security', () => {
  test('every API route requires the Cognito JWT authorizer', () => {
    const routes = t.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes)).toHaveLength(8);
    for (const r of Object.values(routes) as any[]) {
      expect(r.Properties.AuthorizationType).toBe('JWT');
    }
  });

  test('API is throttled globally and on paid AI routes', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      RouteSettings: Match.objectLike({ 'POST /voice/parse': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 } }),
      AccessLogSettings: Match.anyValue(),
    });
  });

  test('buckets block public access, enforce TLS and expire scans', () => {
    t.resourceCountIs('AWS::S3::Bucket', 2);
    t.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.anyValue(),
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30 })]) },
    });
    const policies = Object.values(t.findResources('AWS::S3::BucketPolicy')) as any[];
    expect(policies.every((p) => JSON.stringify(p).includes('aws:SecureTransport'))).toBe(true);
  });

  test('only the Rust signer can read the signing secret', () => {
    const readers = Object.entries(t.findResources('AWS::IAM::Policy')).filter(([, p]: any) =>
      p.Properties.PolicyDocument.Statement.some((s: any) =>
        [].concat(s.Action).includes('secretsmanager:GetSecretValue' as never)));
    expect(readers).toHaveLength(1);
    expect(JSON.stringify(readers[0][1])).toContain('LedgerSigner');
  });

  test('table has point-in-time recovery, encryption and deletion protection by default', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([Match.objectLike({
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
      })]),
      SSESpecification: Match.anyValue(),
    });
  });

  test('bedrock permission is limited to Anthropic models, nothing is wildcard-admin', () => {
    const stmts = allStatements();
    expect(stmts.some((s: any) => s.Action === '*' || (Array.isArray(s.Action) && s.Action.includes('*')))).toBe(false);
    const bedrock = stmts.find((s: any) => s.Action === 'bedrock:InvokeModel');
    expect(JSON.stringify(bedrock.Resource)).toContain('foundation-model/anthropic.*');
  });

  test('cognito: email sign-in, strong-enough passwords, no client secret in the app', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 8, RequireNumbers: true }) },
      UsernameAttributes: ['email'],
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
  });
});

describe('architecture', () => {
  test('signer is a Rust (provided.al2023, arm64) Lambda with the secret ARN', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023', Architectures: ['arm64'], Handler: 'bootstrap',
      Environment: { Variables: Match.objectLike({ LEDGER_SECRET_ARN: Match.anyValue() }) },
    });
  });

  test('nightly ML batch runs at 02:00 IST as a container Lambda', () => {
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(30 20 * * ? *)' });
    t.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', MemorySize: 2048, Timeout: 600 });
  });

  test('python API lambdas use 3.12 on arm64 with bounded log retention', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function')) as any[];
    const py = fns.filter((f) => f.Properties.Runtime === 'python3.12');
    expect(py.length).toBe(5);
    py.forEach((f) => expect(f.Properties.Architectures).toEqual(['arm64']));
    const groups = Object.values(t.findResources('AWS::Logs::LogGroup')) as any[];
    groups.forEach((g) => expect(g.Properties.RetentionInDays).toBe(30));
  });

  test('budget alarm and outputs needed by the app exist', () => {
    t.resourceCountIs('AWS::Budgets::Budget', 1);
    for (const o of ['ApiUrl', 'UserPoolId', 'UserPoolClientId', 'Region', 'SageMakerRoleArn']) {
      t.hasOutput(o, Match.anyValue());
    }
  });

  test('demo mode allows clean teardown; no budget without an email', () => {
    const demo = synth({ dataRemovalPolicy: RemovalPolicy.DESTROY, alertEmail: undefined });
    demo.resourceCountIs('AWS::Budgets::Budget', 0);
    demo.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([Match.objectLike({ DeletionProtectionEnabled: false })]),
    });
  });
});
