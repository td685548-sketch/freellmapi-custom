import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { createApiKeyAccount } from '../../custom/provider-accounts/store.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { TOOL_PROTOCOLS, toolProbeRequest } from '../../custom/x-gateway/tool-probe.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function createSelfSignedCertPem(publicKey: crypto.KeyObject, privateKey: crypto.KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const oidSha256Rsa = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00]);
  const algId = derTlv(0x30, oidSha256Rsa);
  const version = derTlv(0xa0, derTlv(0x02, Buffer.from([0x02])));
  const serial = derTlv(0x02, Buffer.from([0x01]));
  const oidCn = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
  const cnVal = derTlv(0x0c, Buffer.from('idp.example.test', 'utf8'));
  const rdn = derTlv(0x31, derTlv(0x30, Buffer.concat([oidCn, cnVal])));
  const name = derTlv(0x30, rdn);
  const validity = derTlv(
    0x30,
    Buffer.concat([
      derTlv(0x17, Buffer.from('260101000000Z', 'ascii')),
      derTlv(0x17, Buffer.from('350101000000Z', 'ascii')),
    ]),
  );
  const tbs = derTlv(0x30, Buffer.concat([version, serial, algId, name, validity, name, spki]));
  const sig = crypto.sign('RSA-SHA256', tbs, privateKey);
  const bitString = derTlv(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
  const certDer = derTlv(0x30, Buffer.concat([tbs, algId, bitString]));
  const b64 = certDer.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

function buildSignedSamlResponseB64(params: {
  privateKey: crypto.KeyObject;
  inResponseTo: string;
  email: string;
  tamperAfterSign?: boolean;
}): string {
  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 300_000).toISOString();
  const assertionInner =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assert1" Version="2.0" IssueInstant="${nowIso}">`
    + `<saml:Issuer>https://idp.example.test</saml:Issuer>`
    + `<saml:Subject><saml:NameID>${params.email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`
    + `<saml:SubjectConfirmationData NotOnOrAfter="${futureIso}" InResponseTo="${params.inResponseTo}"/>`
    + `</saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${nowIso}" NotOnOrAfter="${futureIso}"><saml:AudienceRestriction><saml:Audience>urn:freellmapi:sp</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${params.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;

  const digestB64 = crypto.createHash('sha256').update(assertionInner, 'utf8').digest('base64');
  const signedInfo =
    `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">`
    + `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>`
    + `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>`
    + `<ds:Reference URI="#_assert1">`
    + `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`
    + `<ds:DigestValue>${digestB64}</ds:DigestValue>`
    + `</ds:Reference></ds:SignedInfo>`;
  const sigB64 = crypto.sign('RSA-SHA256', Buffer.from(signedInfo, 'utf8'), params.privateKey).toString('base64');
  const signatureXml = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sigB64}</ds:SignatureValue></ds:Signature>`;
  let signedAssertion = assertionInner.replace('</saml:Issuer>', `</saml:Issuer>${signatureXml}`);
  if (params.tamperAfterSign) {
    signedAssertion = signedAssertion.replace(params.email, 'attacker@evil.test');
  }
  const envelope =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_resp1" Version="2.0" IssueInstant="${nowIso}" InResponseTo="${params.inResponseTo}">`
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + signedAssertion
    + `</samlp:Response>`;
  return Buffer.from(envelope, 'utf8').toString('base64');
}

function cookiePair(setCookies: string[], name: string): string {
  const found = setCookies.find(c => c.startsWith(`${name}=`));
  if (!found) return '';
  return found.split(';')[0] ?? '';
}

describe('Wave 6 Enterprise SSO, Translator Inspector, CLI Tools, and /models Metadata', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';
  let gatewayKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'f'.repeat(64);
    initDb(':memory:');
    setEnabled(true);
    const owner = createUser(`wave6-admin-${Date.now()}@example.test`, 'TestPass#1234');
    adminToken = createSession(owner.userId);
    gatewayKey = mintXGatewayClientKey(owner.userId, 'wave6-key').key;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>(r => server?.close(() => r()));
  });

  it('supports OIDC SSO config redaction, PKCE start, signed id_token callback, and handoff completion', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const saveRes = await REAL_FETCH(`${baseUrl}/api/thruline/sso`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        authMode: 'oidc',
        oidcIssuerUrl: 'https://oidc.example.test',
        oidcClientId: 'thruline-client',
        oidcClientSecret: 'oidc-secret-value-123',
        oidcLoginLabel: 'Continue with Corp OIDC',
        autoProvisionMembers: true,
      }),
    });
    expect(saveRes.status).toBe(200);
    const savedBody = await saveRes.text();
    expect(savedBody).not.toContain('oidc-secret-value-123');
    expect(JSON.parse(savedBody).oidcClientSecretConfigured).toBe(true);

    const methodsRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/methods`);
    expect(methodsRes.status).toBe(200);
    expect(await methodsRes.json()).toMatchObject({
      authMode: 'oidc',
      oidcEnabled: true,
      oidcLabel: 'Continue with Corp OIDC',
      samlEnabled: false,
    });

    let capturedNonce = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      if (url === 'https://oidc.example.test/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://oidc.example.test',
          authorization_endpoint: 'https://oidc.example.test/authorize',
          token_endpoint: 'https://oidc.example.test/token',
          jwks_uri: 'https://oidc.example.test/jwks',
        }), { status: 200 });
      }
      if (url === 'https://oidc.example.test/jwks') {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url === 'https://oidc.example.test/token') {
        const jwt = await new SignJWT({
          sub: 'sub-oidc-42',
          email: 'oidc.member@example.test',
          email_verified: true,
          nonce: capturedNonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
          .setIssuer('https://oidc.example.test')
          .setAudience('thruline-client')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return new Response(JSON.stringify({ id_token: jwt, access_token: 'tok-xyz' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const startRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/oidc/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, Host: new URL(baseUrl).host },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(200);
    const { url: authUrl } = (await startRes.json()) as { url: string };
    const authParsed = new URL(authUrl);
    const state = authParsed.searchParams.get('state')!;
    capturedNonce = authParsed.searchParams.get('nonce')!;
    const attemptCookie = cookiePair(startRes.headers.getSetCookie(), 'flm_sso_attempt');
    expect(attemptCookie).toContain('flm_sso_attempt=');

    const cbRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/oidc/callback?code=code-9&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: attemptCookie, Host: new URL(baseUrl).host },
      redirect: 'manual',
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('location')).toContain('/?auth=sso');
    const resultCookie = cookiePair(cbRes.headers.getSetCookie(), 'flm_sso_result');
    expect(resultCookie).toContain('flm_sso_result=');

    const completeRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/complete`, {
      method: 'POST',
      headers: { Cookie: resultCookie, Origin: baseUrl, Host: new URL(baseUrl).host },
    });
    expect(completeRes.status).toBe(200);
    const sessionData = (await completeRes.json()) as { token: string; email: string; role: string; apiKey?: string };
    expect(sessionData.email).toBe('oidc.member@example.test');
    expect(sessionData.role).toBe('member');
    expect(sessionData.token).toBeTruthy();
    expect(sessionData.apiKey).toBeTruthy();
  });

  it('supports zero-dep SAML 2.0 metadata, AuthnRequest, RSA-SHA256 ACS verification, and tamper/XXE rejection', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = createSelfSignedCertPem(publicKey, privateKey);

    const putRes = await REAL_FETCH(`${baseUrl}/api/thruline/sso`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        authMode: 'saml',
        samlEntryPoint: 'https://saml.example.test/sso',
        samlIssuer: 'urn:freellmapi:sp',
        samlCert: certPem,
        autoProvisionMembers: true,
      }),
    });
    expect(putRes.status).toBe(200);

    const metaRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/metadata`, {
      headers: { Host: new URL(baseUrl).host },
    });
    expect(metaRes.status).toBe(200);
    const metaXml = await metaRes.text();
    expect(metaXml).toContain('urn:freellmapi:sp');
    expect(metaXml).toContain('/api/auth/sso/saml/acs');

    const startRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, Host: new URL(baseUrl).host },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(200);
    const { url } = (await startRes.json()) as { url: string };
    const u = new URL(url);
    expect(u.searchParams.get('SAMLRequest')).toBeTruthy();
    const relayState = u.searchParams.get('RelayState')!;
    const samlAttempt = cookiePair(startRes.headers.getSetCookie(), 'flm_sso_attempt');

    // Inspect AuthnRequest ID via zlib inflate
    const zlib = await import('node:zlib');
    const reqXml = zlib.inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    const reqId = /ID="([^"]+)"/.exec(reqXml)![1];

    // 1. Tampered SAMLResponse must fail
    const badB64 = buildSignedSamlResponseB64({ privateKey, inResponseTo: reqId, email: 'saml.user@example.test', tamperAfterSign: true });
    const failRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: samlAttempt, Host: new URL(baseUrl).host },
      body: new URLSearchParams({ SAMLResponse: badB64, RelayState: relayState }).toString(),
      redirect: 'manual',
    });
    expect(failRes.status).toBe(302);
    expect(failRes.headers.get('location')).toContain('auth_error=sso_failed');

    // 2. XXE payload must fail
    const xxeB64 = Buffer.from('<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><samlp:Response/>', 'utf8').toString('base64');
    const xxeRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: new URL(baseUrl).host },
      body: new URLSearchParams({ SAMLResponse: xxeB64 }).toString(),
      redirect: 'manual',
    });
    expect(xxeRes.status).toBe(302);
    expect(xxeRes.headers.get('location')).toContain('auth_error=sso_failed');

    // 3. Valid signed SAMLResponse succeeds via fresh attempt
    const startOk = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, Host: new URL(baseUrl).host },
      body: JSON.stringify({}),
    });
    const okData = (await startOk.json()) as { url: string };
    const okUrl = new URL(okData.url);
    const okRelay = okUrl.searchParams.get('RelayState')!;
    const okReqXml = zlib.inflateRawSync(Buffer.from(okUrl.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    const okReqId = /ID="([^"]+)"/.exec(okReqXml)![1];
    const okAttempt = cookiePair(startOk.headers.getSetCookie(), 'flm_sso_attempt');

    const goodB64 = buildSignedSamlResponseB64({ privateKey, inResponseTo: okReqId, email: 'saml.user@example.test' });
    const acsRes = await REAL_FETCH(`${baseUrl}/api/auth/sso/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: okAttempt, Host: new URL(baseUrl).host },
      body: new URLSearchParams({ SAMLResponse: goodB64, RelayState: okRelay }).toString(),
      redirect: 'manual',
    });
    expect(acsRes.status).toBe(302);
    expect(acsRes.headers.get('location')).toContain('/?auth=sso');
    const samlResult = cookiePair(acsRes.headers.getSetCookie(), 'flm_sso_result');

    const completeSaml = await REAL_FETCH(`${baseUrl}/api/auth/sso/complete`, {
      method: 'POST',
      headers: { Cookie: samlResult, Origin: baseUrl, Host: new URL(baseUrl).host },
    });
    expect(completeSaml.status).toBe(200);
    expect(((await completeSaml.json()) as any).email).toBe('saml.user@example.test');
  });

  it('supports extended Translator Inspector protocols, saved cases CRUD, CLI tools, and /models metadata', async () => {
    // Translator inspect across kiro, antigravity, vertex, ollama, cursor
    for (const [src, dst, payload] of [
      ['openai_chat', 'kiro', { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'Hello Kiro' }] }],
      ['openai_chat', 'antigravity', { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hello AG' }] }],
      ['openai_chat', 'vertex', { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'Hello Vertex' }] }],
      ['ollama', 'openai_chat', { model: 'llama3.3', messages: [{ role: 'user', content: 'Hi' }], options: { temperature: 0.2 } }],
      ['cursor', 'anthropic', { modelDetails: { modelName: 'claude-sonnet-4.5' }, conversation: [{ type: 1, role: 'user', text: 'Review' }] }],
    ] as const) {
      const r = await REAL_FETCH(`${baseUrl}/api/thruline/translator/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sourceProtocol: src, targetProtocol: dst, payload }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { success: boolean; transformed: Record<string, unknown> };
      expect(j.success).toBe(true);
      if (dst === 'kiro') expect(j.transformed).toHaveProperty('conversationState');
      if (dst === 'antigravity') expect(j.transformed).toHaveProperty('requestType', 'agent');
    }

    // Saved test cases CRUD
    const createCase = await REAL_FETCH(`${baseUrl}/api/thruline/translator/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Kiro Test Case',
        sourceProtocol: 'openai_chat',
        targetProtocol: 'kiro',
        payload: { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] },
      }),
    });
    expect(createCase.status).toBe(201);
    const created = (await createCase.json()) as { case: { id: string } };
    const listCases = await REAL_FETCH(`${baseUrl}/api/thruline/translator/cases`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(((await listCases.json()) as any).cases).toHaveLength(1);
    const delCase = await REAL_FETCH(`${baseUrl}/api/thruline/translator/cases/${created.case.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delCase.status).toBe(200);

    // CLI Tools protocols + endpoint check
    for (const id of ['hermes', 'amp', 'qwen', 'crush', 'pi', 'codewhale', 'forge', 'smelt', 'kiro', 'droid']) {
      expect(TOOL_PROTOCOLS[id]).toBeTruthy();
      expect(toolProbeRequest({ toolId: id, key: 'sk-test', model: 'auto' }).endpoint).toContain('/thruline/');
    }
    const toolsListRes = await REAL_FETCH(`${baseUrl}/api/thruline/tools`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(toolsListRes.status).toBe(200);
    const toolsJson = (await toolsListRes.json()) as { tools: Array<{ id: string }> };
    expect(toolsJson.tools.some(t => t.id === 'hermes')).toBe(true);

    // GET /thruline/v1/models capabilities + thinking_levels
    createApiKeyAccount({
      provider: 'anthropic',
      key: 'sk-ant-test',
      label: 'Claude Meta',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude 4.5' }],
    });
    const modelsRes = await REAL_FETCH(`${baseUrl}/thruline/v1/models`, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string; capabilities?: string[]; thinking_levels?: string[] }> };
    const claudeEntry = modelsJson.data.find(m => m.id === 'claude-sonnet-4-5');
    expect(claudeEntry?.capabilities).toContain('chat');
    expect(claudeEntry?.capabilities).toContain('thinking');
    expect(claudeEntry?.thinking_levels).toEqual(['low', 'medium', 'high']);
  });
});
