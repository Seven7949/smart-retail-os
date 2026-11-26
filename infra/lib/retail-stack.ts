import * as path from 'path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_budgets as budgets,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_ecr_assets as ecrAssets,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secrets,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface RetailStackProps extends StackProps {
  /** Email for the cost-budget alert and the optional daily digest. */
  readonly alertEmail?: string;
  /** Monthly AWS budget in USD before an alert email is sent. */
  readonly monthlyBudgetUsd?: number;
  /** Folder containing the Rust `bootstrap` binary (cargo lambda build output). */
  readonly signerAssetPath: string;
  /** Folder of the Python Lambda sources. */
  readonly backendSrcPath: string;
  /** Folder with ml/Dockerfile.batch (container image for the nightly ML job). */
  readonly mlPath: string;
  readonly bedrockModelId?: string;
  /** RETAIN for real shop data; DESTROY is convenient for a student demo account. */
  readonly dataRemovalPolicy?: RemovalPolicy;
}

const ONE_MONTH = logs.RetentionDays.ONE_MONTH;
const DEFAULT_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

export class RetailStack extends Stack {
  constructor(scope: Construct, id: string, props: RetailStackProps) {
    super(scope, id, props);
    Tags.of(this).add('Project', 'SmartRetailOS');
    const removal = props.dataRemovalPolicy ?? RemovalPolicy.RETAIN;
    const destroy = removal === RemovalPolicy.DESTROY;

    // ---------------- Identity ----------------
    const userPool = new cognito.UserPool(this, 'Shops', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 8, requireDigits: true, requireLowercase: true, requireUppercase: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: removal,
    });
    const appClient = userPool.addClient('MobileApp', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    // ---------------- Data ----------------
    const table = new dynamodb.TableV2(this, 'Data', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      deletionProtection: !destroy,
      removalPolicy: removal,
    });

    const secureBucket = (id: string, expireDays: number) => new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(expireDays), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: destroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: destroy,
    });
    const scans = secureBucket('InvoiceScans', 30);
    const artifacts = secureBucket('MlArtifacts', 90);

    const signingSecret = new secrets.Secret(this, 'LedgerSigningSecret', {
      description: 'Seed for the Ed25519 ledger signing key. Readable only by the Rust signer.',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: removal,
    });

    const digestTopic = new sns.Topic(this, 'DailyDigest', { enforceSSL: true });
    if (props.alertEmail) digestTopic.addSubscription(new subs.EmailSubscription(props.alertEmail));

    // ---------------- Rust ledger signer ----------------
    const signer = new lambda.Function(this, 'LedgerSigner', {
      description: 'Rust: validates hash chains and signs bills with Ed25519',
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64, // built natively inside Amazon Linux 2023 by the deploy workflow
      handler: 'bootstrap',
      code: lambda.Code.fromAsset(props.signerAssetPath),
      memorySize: 128,
      timeout: Duration.seconds(10),
      environment: { LEDGER_SECRET_ARN: signingSecret.secretArn, RUST_LOG: 'info' },
      logGroup: new logs.LogGroup(this, 'SignerLogs', { retention: ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    signingSecret.grantRead(signer);

    // ---------------- Nightly ML batch (container) ----------------
    const mlBatch = new lambda.DockerImageFunction(this, 'MlBatch', {
      description: 'Per-shop forecasting, reorder, basket rules, segments, udhaar risk',
      code: lambda.DockerImageCode.fromImageAsset(props.mlPath, {
        file: 'Dockerfile.batch',
        platform: ecrAssets.Platform.LINUX_AMD64,
        exclude: ['tests', 'reports', '**/__pycache__', '.pytest_cache'],
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      timeout: Duration.minutes(10),
      environment: { TABLE_NAME: table.tableName, DIGEST_TOPIC_ARN: digestTopic.topicArn },
      logGroup: new logs.LogGroup(this, 'MlBatchLogs', { retention: ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    table.grantReadWriteData(mlBatch);
    digestTopic.grantPublish(mlBatch);
    new events.Rule(this, 'NightlyInsights', {
      description: '02:00 IST every night',
      schedule: events.Schedule.cron({ minute: '30', hour: '20' }),
      targets: [new targets.LambdaFunction(mlBatch, { retryAttempts: 1 })],
    });

    // ---------------- API Lambdas (Python) ----------------
    const code = lambda.Code.fromAsset(props.backendSrcPath, { exclude: ['**/__pycache__', '**/*.pyc'] });
    const api = (id: string, handler: string, env: Record<string, string>, timeout = 15, memory = 256) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler,
        code,
        memorySize: memory,
        timeout: Duration.seconds(timeout),
        environment: { TABLE_NAME: table.tableName, ...env },
        logGroup: new logs.LogGroup(this, `${id}Logs`, { retention: ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      });

    const syncFn = api('SyncFn', 'handlers.sync.handler', { SIGNER_FUNCTION: signer.functionName }, 30, 512);
    table.grantReadWriteData(syncFn);
    signer.grantInvoke(syncFn);

    const insightsFn = api('InsightsFn', 'handlers.insights.handler', { ML_FUNCTION: mlBatch.functionName });
    table.grantReadWriteData(insightsFn);
    mlBatch.grantInvoke(insightsFn);

    const ledgerFn = api('LedgerFn', 'handlers.ledger.handler', { SIGNER_FUNCTION: signer.functionName }, 30, 512);
    table.grantReadData(ledgerFn);
    signer.grantInvoke(ledgerFn);

    const scanFn = api('ScanFn', 'handlers.scan.handler', { SCAN_BUCKET: scans.bucketName }, 30);
    scans.grantPut(scanFn, 'scans/*');
    scans.grantRead(scanFn, 'scans/*');
    scanFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['textract:AnalyzeExpense'], resources: ['*'] }));

    const voiceFn = api('VoiceFn', 'handlers.voice.handler', { BEDROCK_MODEL_ID: props.bedrockModelId ?? DEFAULT_MODEL }, 30);
    voiceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*anthropic.*`,
      ],
    }));

    // ---------------- HTTP API ----------------
    const httpApi = new apigw.HttpApi(this, 'Api', {
      description: 'Smart Retail OS API (JWT-protected)',
      createDefaultStage: false,
      defaultAuthorizer: new authorizers.HttpJwtAuthorizer(
        'CognitoJwt',
        `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
        { jwtAudience: [appClient.userPoolClientId] },
      ),
    });
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const stage = new apigw.HttpStage(this, 'Stage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: { destination: new apigw.LogGroupLogDestination(accessLogs) },
    });
    // Tighter limits on the routes that cost money per call (Textract, Bedrock).
    (stage.node.defaultChild as apigw.CfnStage).addPropertyOverride('RouteSettings', {
      'POST /voice/parse': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      'POST /scan/parse': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 3 },
      'POST /insights/refresh': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
    });

    const route = (p: string, method: apigw.HttpMethod, fn: lambda.IFunction, id: string) =>
      httpApi.addRoutes({ path: p, methods: [method], integration: new integrations.HttpLambdaIntegration(id, fn) });
    route('/sync', apigw.HttpMethod.POST, syncFn, 'SyncInt');
    route('/insights', apigw.HttpMethod.GET, insightsFn, 'InsightsGetInt');
    route('/insights/refresh', apigw.HttpMethod.POST, insightsFn, 'InsightsRefreshInt');
    route('/ledger/verify', apigw.HttpMethod.GET, ledgerFn, 'LedgerVerifyInt');
    route('/ledger/public-key', apigw.HttpMethod.GET, ledgerFn, 'LedgerKeyInt');
    route('/scan/upload-url', apigw.HttpMethod.POST, scanFn, 'ScanUrlInt');
    route('/scan/parse', apigw.HttpMethod.POST, scanFn, 'ScanParseInt');
    route('/voice/parse', apigw.HttpMethod.POST, voiceFn, 'VoiceInt');

    // ---------------- SageMaker training role ----------------
    const smRole = new iam.Role(this, 'SageMakerTrainingRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Least-privilege role for the demand-model training job',
    });
    artifacts.grantReadWrite(smRole);
    smRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'cloudwatch:PutMetricData',
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: ['*'],
    }));

    // ---------------- Cost guardrail ----------------
    if (props.alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetType: 'COST', timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd ?? 10, unit: 'USD' },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail! }],
        })),
      });
    }

    // ---------------- Outputs (copied into the app at build time) ----------------
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: appClient.userPoolClientId });
    new CfnOutput(this, 'ArtifactsBucket', { value: artifacts.bucketName });
    new CfnOutput(this, 'SageMakerRoleArn', { value: smRole.roleArn });
    new CfnOutput(this, 'SignerFunctionName', { value: signer.functionName });
  }
}

export const repoPath = (...p: string[]) => path.resolve(__dirname, '..', '..', ...p);
