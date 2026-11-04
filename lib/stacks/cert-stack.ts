import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface CertStackProps extends cdk.StackProps {
  /** Wildcard domain for server cert SAN, e.g. '*.genai-gw.internal' */
  domain: string;
  /** Base domain also added as SAN, e.g. 'genai-gw.internal' */
  baseDomain: string;
}

/**
 * Generates a self-signed CA + wildcard server cert via Lambda Custom Resource,
 * imports the server cert into ACM, and stores the CA cert in Secrets Manager
 * for distribution to researcher PCs.
 *
 * Usage pattern:
 *   researcher installs CA cert → trusts *.genai-gw.internal HTTPS
 *   ANTHROPIC_BASE_URL=https://gateway.genai-gw.internal
 */
export class CertStack extends cdk.Stack {
  /** ACM certificate ARN — pass to ALB HTTPS listeners */
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const certGenRole = new iam.Role(this, 'CertGenRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        CertGen: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['acm:ImportCertificate', 'acm:DeleteCertificate'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: [
                'secretsmanager:CreateSecret',
                'secretsmanager:PutSecretValue',
              ],
              resources: [
                `arn:aws:secretsmanager:ap-northeast-2:*:secret:/genai-gw/gateway/ca-cert*`,
              ],
            }),
          ],
        }),
      },
    });

    const certGenFn = new lambda.Function(this, 'CertGenFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: certGenRole,
      timeout: cdk.Duration.minutes(10),
      code: lambda.Code.fromInline(`
import re, subprocess, boto3, tempfile

# Only hostnames and wildcard hostnames are valid here. Validating before the
# values reach openssl -subj / SAN config is defense-in-depth: subprocess is
# already invoked with argument lists (no shell), so this guards against
# malformed input rather than shell injection.
_DOMAIN_RE = re.compile(r'^(\\*\\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$', re.IGNORECASE)

def _validate_domain(value, field):
    if not isinstance(value, str) or not _DOMAIN_RE.match(value):
        raise ValueError(f'Invalid {field}: {value!r}')
    return value

def run(cmd):
    r = subprocess.run(cmd, check=True, capture_output=True)
    return r

def handler(event, context):
    if event['RequestType'] == 'Delete':
        cert_arn = event.get('PhysicalResourceId', '')
        if cert_arn.startswith('arn:'):
            try:
                boto3.client('acm', region_name='ap-northeast-2').delete_certificate(CertificateArn=cert_arn)
            except Exception as e:
                print(f'ACM delete skipped: {e}')
        return {'PhysicalResourceId': cert_arn}

    domain      = _validate_domain(event['ResourceProperties']['Domain'], 'Domain')
    base_domain = _validate_domain(event['ResourceProperties']['BaseDomain'], 'BaseDomain')

    with tempfile.TemporaryDirectory() as tmp:
        # CA key (2048-bit) + self-signed cert (10 years)
        run(['openssl','genrsa','-out',f'{tmp}/ca.key','2048'])
        run(['openssl','req','-x509','-new','-nodes',
             '-key',f'{tmp}/ca.key','-sha256','-days','3650',
             '-out',f'{tmp}/ca.crt',
             '-subj','/CN=GenAI-GW-Internal-CA/O=GenAI-GW/C=KR'])

        # Server key + CSR
        run(['openssl','genrsa','-out',f'{tmp}/srv.key','2048'])
        run(['openssl','req','-new',
             '-key',f'{tmp}/srv.key','-out',f'{tmp}/srv.csr',
             '-subj',f'/CN={domain}/O=GenAI-GW/C=KR'])

        # SAN extension (wildcard + base domain)
        with open(f'{tmp}/ext.cnf','w') as f:
            f.write(f'[v3_req]\\nsubjectAltName=DNS:{domain},DNS:{base_domain}\\n')

        # Sign server cert with CA (10 years)
        run(['openssl','x509','-req',
             '-in',f'{tmp}/srv.csr','-CA',f'{tmp}/ca.crt',
             '-CAkey',f'{tmp}/ca.key','-CAcreateserial',
             '-out',f'{tmp}/srv.crt','-days','3650','-sha256',
             '-extfile',f'{tmp}/ext.cnf','-extensions','v3_req'])

        srv_crt = open(f'{tmp}/srv.crt').read()
        srv_key = open(f'{tmp}/srv.key').read()
        ca_crt  = open(f'{tmp}/ca.crt').read()

    acm = boto3.client('acm', region_name='ap-northeast-2')
    sm  = boto3.client('secretsmanager', region_name='ap-northeast-2')

    kwargs = dict(
        Certificate=srv_crt.encode(),
        PrivateKey=srv_key.encode(),
        CertificateChain=ca_crt.encode(),
    )
    if event['RequestType'] == 'Update':
        try:
            resp = acm.import_certificate(CertificateArn=event['PhysicalResourceId'], **kwargs)
        except Exception:
            resp = acm.import_certificate(**kwargs)
    else:
        resp = acm.import_certificate(**kwargs)

    cert_arn = resp['CertificateArn']

    # Store CA cert in Secrets Manager for researcher PC distribution
    secret_name = '/genai-gw/gateway/ca-cert'
    try:
        sm.put_secret_value(SecretId=secret_name, SecretString=ca_crt)
    except sm.exceptions.ResourceNotFoundException:
        sm.create_secret(
            Name=secret_name,
            SecretString=ca_crt,
            Description='GenAI Gateway Internal CA cert — install on researcher PCs to trust HTTPS',
        )

    return {
        'PhysicalResourceId': cert_arn,
        'Data': {'CertificateArn': cert_arn},
    }
`),
    });

    const provider = new cr.Provider(this, 'CertGenProvider', {
      onEventHandler: certGenFn,
    });

    const certResource = new cdk.CustomResource(this, 'CertResource', {
      serviceToken: provider.serviceToken,
      properties: {
        Domain: props.domain,
        BaseDomain: props.baseDomain,
      },
    });

    this.certificateArn = certResource.getAttString('CertificateArn');

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificateArn,
      description: 'ACM cert ARN — wildcard self-signed cert for *.genai-gw.internal',
    });
    new cdk.CfnOutput(this, 'CaCertDownloadCmd', {
      value: [
        'aws secretsmanager get-secret-value',
        '--secret-id /genai-gw/gateway/ca-cert',
        '--query SecretString --output text',
        '--region ap-northeast-2 > genai-gw-ca.crt',
      ].join(' '),
      description: 'Download CA cert (macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain genai-gw-ca.crt)',
    });
  }
}
