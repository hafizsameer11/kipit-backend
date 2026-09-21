import { env, premblyBaseUrl, premblyUseMock } from "../lib/env.js";
import { AppError } from "../lib/errors.js";

export type PremblyPerson = {
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  fullName: string;
};

export type PremblyVerifyResult =
  | {
      ok: true;
      responseCode: string;
      reference?: string;
      person: PremblyPerson;
      raw: unknown;
    }
  | {
      ok: false;
      responseCode: string;
      retryable: boolean;
      message: string;
      reference?: string;
      raw: unknown;
    };

type PremblyEnvelope = {
  status?: boolean;
  detail?: string;
  message?: string;
  response_code?: string | number;
  data?: Record<string, unknown> | null;
  nin_data?: Record<string, unknown> | null;
  verification?: { status?: string; reference?: string; verification_id?: string };
  reference_id?: string;
};

function codeOf(body: PremblyEnvelope): string {
  const c = body.response_code;
  if (c === undefined || c === null) return body.status === false ? "99" : "00";
  return String(c).padStart(2, "0");
}

function pickName(data: Record<string, unknown> | null | undefined): PremblyPerson | null {
  if (!data) return null;
  const firstName = String(data.firstName ?? data.firstname ?? "").trim();
  const middleName = String(data.middleName ?? data.middlename ?? "").trim() || undefined;
  const lastName = String(data.lastName ?? data.lastname ?? data.surname ?? "").trim();
  if (!firstName && !lastName) return null;
  const parts = [firstName, middleName, lastName].filter(Boolean);
  return {
    firstName: firstName || lastName,
    middleName,
    lastName: lastName || firstName,
    dateOfBirth: String(data.dateOfBirth ?? data.birthdate ?? "").trim() || undefined,
    phoneNumber: String(data.phoneNumber ?? data.phoneNumber1 ?? data.telephoneno ?? "").trim() || undefined,
    fullName: parts.join(" ").replace(/\s+/g, " ").trim(),
  };
}

function classifyFailure(code: string, detail: string): PremblyVerifyResult {
  const retryable = code === "02" || code === "03";
  return {
    ok: false,
    responseCode: code,
    retryable,
    message: detail || defaultMessage(code),
    raw: { response_code: code, detail },
  };
}

function defaultMessage(code: string): string {
  switch (code) {
    case "01":
      return "Record not found. Check the number and try again.";
    case "02":
      return "Verification service temporarily unavailable. We'll retry shortly.";
    case "03":
      return "Verification wallet balance insufficient. We'll retry shortly.";
    case "07":
      return "This BVN is blocked or watch-listed and cannot be used.";
    default:
      return "Identity verification failed.";
  }
}

async function premblyPost(path: string, body: Record<string, string>): Promise<PremblyEnvelope> {
  const url = `${premblyBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Latest Prembly auth: secret key only — no app-id header.
      "x-api-key": env.PREMBLY_API_KEY,
    },
    body: JSON.stringify(body),
  });

  let json: PremblyEnvelope = {};
  try {
    json = (await res.json()) as PremblyEnvelope;
  } catch {
    json = { status: false, detail: `Prembly returned HTTP ${res.status}` };
  }

  if (!res.ok && res.status !== 200) {
    // Map transport failures to retryable soft errors where sensible.
    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Prembly API key rejected", "PREMBLY_AUTH");
    }
    if (res.status >= 500 || res.status === 429) {
      return {
        status: false,
        response_code: "02",
        detail: json.detail || json.message || `Prembly HTTP ${res.status}`,
      };
    }
  }

  return json;
}

function interpret(body: PremblyEnvelope, person: PremblyPerson | null): PremblyVerifyResult {
  const code = codeOf(body);
  const detail = String(body.detail || body.message || "").trim();
  const reference =
    body.verification?.reference?.trim() ||
    body.reference_id ||
    body.verification?.verification_id;

  if (code === "00" && person) {
    return { ok: true, responseCode: code, reference, person, raw: body };
  }
  if (code === "00" && !person) {
    return classifyFailure("01", detail || "Record not found");
  }
  return {
    ...classifyFailure(code, detail),
    reference,
    raw: body,
  };
}

/** Prembly BVN Basic — POST /verification/bvn_validation { number } */
export async function verifyBvnWithPrembly(
  bvn: string,
  nameHint?: string,
): Promise<PremblyVerifyResult> {
  if (premblyUseMock()) return mockBvn(bvn, nameHint);

  const body = await premblyPost("/verification/bvn_validation", { number: bvn });
  const person = pickName(body.data ?? undefined);
  return interpret(body, person);
}

/** Prembly NIN Basic — POST /verification/vnin-basic { number } */
export async function verifyNinWithPrembly(
  nin: string,
  nameHint?: string,
): Promise<PremblyVerifyResult> {
  if (premblyUseMock()) return mockNin(nin, nameHint);

  const body = await premblyPost("/verification/vnin-basic", { number: nin });
  const person = pickName(body.nin_data ?? body.data ?? undefined);
  return interpret(body, person);
}

function personFromHint(hint?: string): PremblyPerson {
  const parts = (hint || "Verified Customer").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "Verified";
  const lastName = parts.length > 1 ? parts[parts.length - 1]! : "Customer";
  const middleName = parts.length > 2 ? parts.slice(1, -1).join(" ") : undefined;
  return {
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(" "),
  };
}

/** Sandbox helpers when PREMBLY_API_KEY is unset. */
function mockBvn(bvn: string, nameHint?: string): PremblyVerifyResult {
  // Prembly docs test BVN
  if (bvn === "54651333604") {
    return {
      ok: true,
      responseCode: "00",
      reference: `mock-bvn-${bvn}`,
      person: {
        firstName: "John",
        middleName: "Doe",
        lastName: "Jane",
        dateOfBirth: "01-Jan-2000",
        phoneNumber: "08012345678",
        fullName: "John Doe Jane",
      },
      raw: { mock: true },
    };
  }
  if (bvn === "22123456789") {
    const person = nameHint ? personFromHint(nameHint) : personFromHint("Adaeze Okonkwo");
    return {
      ok: true,
      responseCode: "00",
      reference: `mock-bvn-${bvn}`,
      person,
      raw: { mock: true },
    };
  }
  if (bvn.endsWith("0000")) {
    return classifyFailure("01", "Record not found");
  }
  if (bvn.endsWith("0007")) {
    return classifyFailure("07", "BVN is blocked/watch-listed");
  }
  return {
    ok: true,
    responseCode: "00",
    reference: `mock-bvn-${bvn}`,
    person: personFromHint(nameHint),
    raw: { mock: true },
  };
}

function mockNin(nin: string, nameHint?: string): PremblyVerifyResult {
  if (nin === "12345678901" || nin === "56182742701") {
    return {
      ok: true,
      responseCode: "00",
      reference: `mock-nin-${nin}`,
      person: {
        firstName: nin === "56182742701" ? "Grace" : "Chidera",
        middleName: nin === "56182742701" ? "Chimamanda" : "Anita",
        lastName: nin === "56182742701" ? "Amanda" : "Johnson",
        fullName:
          nin === "56182742701" ? "Grace Chimamanda Amanda" : "Chidera Anita Johnson",
      },
      raw: { mock: true },
    };
  }
  if (nin.endsWith("0000")) {
    return classifyFailure("01", "Record not found");
  }
  return {
    ok: true,
    responseCode: "00",
    reference: `mock-nin-${nin}`,
    person: personFromHint(nameHint),
    raw: { mock: true },
  };
}
