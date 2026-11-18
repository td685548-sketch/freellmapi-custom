import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CLOCK_SKEW_MS = 60_000;

export function formatX509Certificate(certStr: string): string {
  if (!certStr || typeof certStr !== 'string') return '';
  const clean = certStr
    .replace(/-----BEGIN CERTIFICATE-----/gi, '')
    .replace(/-----END CERTIFICATE-----/gi, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildSamlAuthorizeRedirectUrl(params: {
  entryPoint: string;
  issuer: string;
  acsUrl: string;
  relayState?: string;
}): { authorizeUrl: string; requestId: string } {
  const requestId = `_${crypto.randomBytes(16).toString('hex')}`;
  const issueInstant = new Date().toISOString();
  const authnRequestXml = [
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
    ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    ` ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}"`,
    ` Destination="${escapeXmlAttr(params.entryPoint)}"`,
    ` AssertionConsumerServiceURL="${escapeXmlAttr(params.acsUrl)}"`,
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">`,
    `<saml:Issuer>${escapeXmlAttr(params.issuer)}</saml:Issuer>`,
    `</samlp:AuthnRequest>`,
  ].join('');

  const deflated = zlib.deflateRawSync(Buffer.from(authnRequestXml, 'utf8')).toString('base64');
  const url = new URL(params.entryPoint);
  url.searchParams.set('SAMLRequest', deflated);
  if (params.relayState) url.searchParams.set('RelayState', params.relayState);
  return { authorizeUrl: url.toString(), requestId };
}

export function buildSpMetadataXml(params: { issuer: string; acsUrl: string }): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXmlAttr(params.issuer)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXmlAttr(params.acsUrl)}" index="1" isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join('\n');
}

function resolveDigestAlgorithm(uri: string): 'sha256' | 'sha1' {
  const low = uri.toLowerCase();
  if (low.includes('sha256')) return 'sha256';
  if (low.includes('sha1')) return 'sha1';
  throw new Error(`Unsupported SAML digest algorithm: ${uri || 'unknown'}`);
}

function resolveVerifyAlgorithm(uri: string): 'RSA-SHA256' | 'RSA-SHA1' {
  const low = uri.toLowerCase();
  if (low.includes('sha256')) return 'RSA-SHA256';
  if (low.includes('sha1')) return 'RSA-SHA1';
  throw new Error(`Unsupported SAML signature algorithm: ${uri || 'unknown'}`);
}

function findElementById(xml: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`<([a-zA-Z0-9_:-]+)\\b[^>]*\\bID=["']${escapedId}["'][^>]*>`, 'i');
  const startMatch = startRe.exec(xml);
  if (!startMatch) return null;
  const tagName = startMatch[1];
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`</?${escapedTag}(?:\\s[^>]*)?>`, 'gi');
  tokenRe.lastIndex = startMatch.index;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const token = m[0];
    if (token.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return xml.slice(startMatch.index, tokenRe.lastIndex);
      }
    } else if (!token.endsWith('/>')) {
      depth += 1;
    } else if (depth === 0) {
      return xml.slice(startMatch.index, tokenRe.lastIndex);
    }
  }
  return null;
}

function extractFirstTagText(xml: string, localName: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${localName}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function extractEmailAndAttributes(xml: string): { email: string; nameId: string } {
  const nameId = extractFirstTagText(xml, 'NameID');
  const attrRe = /<(?:[a-zA-Z0-9_-]+:)?Attribute\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?Attribute>/gi;
  let email = '';
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const nameMatch = /\bName=["']([^"']+)["']/i.exec(attrs);
    const attrName = (nameMatch?.[1] || '').toLowerCase();
    if (
      attrName === 'email'
      || attrName === 'mail'
      || attrName.endsWith('/emailaddress')
      || attrName.endsWith(':email')
    ) {
      const val = extractFirstTagText(inner, 'AttributeValue');
      if (val) {
        email = val;
        break;
      }
    }
  }
  if (!email && nameId.includes('@')) email = nameId;
  return { email, nameId };
}

function verifyXmlSignature(xml: string, idpCertPem: string): string {
  const sigMatch = /<((?:[a-zA-Z0-9_-]+:)?Signature)\b([^>]*)>([\s\S]*?)<\/\1>/i.exec(xml);
  if (!sigMatch) {
    throw new Error('SAML response missing XML digital signature.');
  }
  const fullSignatureBlock = sigMatch[0];
  const sigAttrs = sigMatch[2] || '';
  const sigInner = sigMatch[3];

  const signedInfoMatch = /<((?:[a-zA-Z0-9_-]+:)?SignedInfo)\b([^>]*)>([\s\S]*?)<\/\1>/i.exec(sigInner);
  if (!signedInfoMatch) {
    throw new Error('SAML signature missing SignedInfo element.');
  }
  const rawSignedInfo = signedInfoMatch[0];
  const signedInfoAttrs = signedInfoMatch[2] || '';

  const sigValText = extractFirstTagText(sigInner, 'SignatureValue').replace(/\s+/g, '');
  if (!sigValText) {
    throw new Error('SAML signature missing SignatureValue.');
  }
  const sigMethodMatch = /<(?:[a-zA-Z0-9_-]+:)?SignatureMethod\b[^>]*\bAlgorithm=["']([^"']+)["']/i.exec(rawSignedInfo);
  const verifyAlg = resolveVerifyAlgorithm(sigMethodMatch?.[1] || '');

  const refMatch = /<(?:[a-zA-Z0-9_-]+:)?Reference\b[^>]*\bURI=["']([^"']*)["'][^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?Reference>/i.exec(rawSignedInfo);
  if (!refMatch) {
    throw new Error('SAML SignedInfo missing Reference element.');
  }
  const refUri = refMatch[1];
  const refBody = refMatch[2];
  const digestMethodMatch = /<(?:[a-zA-Z0-9_-]+:)?DigestMethod\b[^>]*\bAlgorithm=["']([^"']+)["']/i.exec(refBody);
  const digestAlg = resolveDigestAlgorithm(digestMethodMatch?.[1] || '');
  const expectedDigestB64 = extractFirstTagText(refBody, 'DigestValue').replace(/\s+/g, '');
  if (!expectedDigestB64) {
    throw new Error('SAML Reference missing DigestValue.');
  }

  let refTargetXml: string | null = null;
  if (!refUri) {
    refTargetXml = xml;
  } else if (refUri.startsWith('#')) {
    refTargetXml = findElementById(xml, refUri.slice(1));
  }
  if (!refTargetXml) {
    throw new Error(`SAML Reference target '${refUri}' not found.`);
  }

  const unsignedTarget = refTargetXml.replace(fullSignatureBlock, '');
  const actualDigestB64 = crypto.createHash(digestAlg).update(unsignedTarget, 'utf8').digest('base64');
  const left = Buffer.from(actualDigestB64);
  const right = Buffer.from(expectedDigestB64);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('SAML Reference digest verification failed (payload tampered).');
  }

  const sigBuf = Buffer.from(sigValText, 'base64');
  const candidateSignedInfos = [rawSignedInfo];
  if (sigAttrs.includes('xmlns:') && !signedInfoAttrs.includes('xmlns:')) {
    const nsMatch = sigAttrs.match(/xmlns:[a-zA-Z0-9_-]+=["'][^"']+["']/g);
    if (nsMatch?.length) {
      candidateSignedInfos.push(rawSignedInfo.replace(/^(<[a-zA-Z0-9_:-]+)/, `$1 ${nsMatch.join(' ')}`));
    }
  }

  const signatureOk = candidateSignedInfos.some(si => {
    try {
      const verifier = crypto.createVerify(verifyAlg);
      verifier.update(si, 'utf8');
      verifier.end();
      return verifier.verify(idpCertPem, sigBuf);
    } catch {
      return false;
    }
  });
  if (!signatureOk) {
    throw new Error('SAML XML signature verification failed.');
  }
  return refTargetXml;
}

export function validateSamlPostResponse(params: {
  samlResponseB64: string;
  idpCertPem: string;
  expectedInResponseTo?: string;
  expectedIssuer?: string;
  nowMs?: number;
}): { email: string; nameId: string; assertionId: string } {
  const pem = formatX509Certificate(params.idpCertPem);
  if (!pem) {
    throw new Error('IdP X.509 certificate is not configured.');
  }
  const xml = Buffer.from(params.samlResponseB64, 'base64').toString('utf8');
  if (!xml.trim()) {
    throw new Error('Empty SAMLResponse payload.');
  }
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('SAMLResponse rejected: DOCTYPE/ENTITY declarations are forbidden.');
  }

  const signedXml = verifyXmlSignature(xml, pem);

  const statusMatch = /<(?:[a-zA-Z0-9_-]+:)?StatusCode\b[^>]*\bValue=["']([^"']+)["']/i.exec(xml);
  if (statusMatch && !statusMatch[1].endsWith(':Success')) {
    throw new Error(`SAML IdP returned failure status: ${statusMatch[1]}`);
  }

  if (params.expectedInResponseTo) {
    const respInResp = /<(?:[a-zA-Z0-9_-]+:)?Response\b[^>]*\bInResponseTo=["']([^"']+)["']/i.exec(xml)?.[1];
    const subjInResp = /<(?:[a-zA-Z0-9_-]+:)?SubjectConfirmationData\b[^>]*\bInResponseTo=["']([^"']+)["']/i.exec(signedXml)?.[1];
    const actualInResp = respInResp || subjInResp || '';
    if (actualInResp !== params.expectedInResponseTo) {
      throw new Error('SAML InResponseTo does not match active authentication request.');
    }
  }

  const assertionIdMatch =
    /<(?:[a-zA-Z0-9_-]+:)?Assertion\b[^>]*\bID=["']([^"']+)["']/i.exec(signedXml) ||
    /<(?:[a-zA-Z0-9_-]+:)?Response\b[^>]*\bID=["']([^"']+)["']/i.exec(signedXml);
  const assertionId = assertionIdMatch?.[1]?.trim() || '';
  if (!assertionId) {
    throw new Error('SAML assertion is missing required ID attribute.');
  }

  const now = params.nowMs ?? Date.now();
  const condMatch = /<(?:[a-zA-Z0-9_-]+:)?Conditions\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?Conditions>/i.exec(signedXml);
  if (condMatch) {
    const condAttrs = condMatch[1] || '';
    const notBeforeRaw = /\bNotBefore=["']([^"']+)["']/i.exec(condAttrs)?.[1];
    const notOnOrAfterRaw = /\bNotOnOrAfter=["']([^"']+)["']/i.exec(condAttrs)?.[1];
    if (notBeforeRaw) {
      const nb = Date.parse(notBeforeRaw);
      if (Number.isFinite(nb) && now + CLOCK_SKEW_MS < nb) {
        throw new Error('SAML assertion is not yet valid (NotBefore).');
      }
    }
    if (notOnOrAfterRaw) {
      const noa = Date.parse(notOnOrAfterRaw);
      if (Number.isFinite(noa) && now - CLOCK_SKEW_MS >= noa) {
        throw new Error('SAML assertion has expired (NotOnOrAfter).');
      }
    }
    const audience = extractFirstTagText(condMatch[2] || '', 'Audience');
    if (audience && params.expectedIssuer && audience !== params.expectedIssuer) {
      throw new Error('SAML assertion Audience mismatch.');
    }
  }

  const { email, nameId } = extractEmailAndAttributes(signedXml);
  if (!email) {
    throw new Error('SAML assertion did not contain an email address.');
  }
  return { email, nameId: nameId || email, assertionId };
}
