import { NextResponse } from "next/server";

import {
  getManagedFieldValue,
  MANAGED_FIELD_PATHS,
  parseManagedFieldValue,
  type PolicyProfile,
} from "@/domain";
import {
  PolicySetSuperDocsSafetyError,
  SuperDocsRequestError,
} from "@/superdocs";

export class PolicySetRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicySetRequestError";
  }
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new PolicySetRequestError("Request body must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new PolicySetRequestError("Request body must be an object.");
  }
  return value;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicySetRequestError(`${key} must be a non-empty string.`);
  }
  return value;
}

export function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new PolicySetRequestError(`${key} must be a boolean.`);
  }
  return value;
}

export function requiredPolicyProfile(value: unknown): PolicyProfile {
  if (!isRecord(value)) {
    throw new PolicySetRequestError("profile must be a PolicyProfile object.");
  }

  const profile = structuredClone(value) as PolicyProfile;
  try {
    for (const path of MANAGED_FIELD_PATHS) {
      const parsed = parseManagedFieldValue(
        path,
        getManagedFieldValue(profile, path),
      );
      if (!parsed.ok) {
        throw new PolicySetRequestError(parsed.error.message);
      }
    }
  } catch (error) {
    if (error instanceof PolicySetRequestError) {
      throw error;
    }
    throw new PolicySetRequestError("profile is missing required policy facts.");
  }
  return profile;
}

export function routeError(error: unknown): NextResponse {
  if (error instanceof PolicySetRequestError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof PolicySetSuperDocsSafetyError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof SuperDocsRequestError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  if (
    error instanceof Error &&
    error.message === "SUPERDOCS_API_KEY is not configured"
  ) {
    return NextResponse.json(
      { error: "SuperDocs is not configured on the server." },
      { status: 503 },
    );
  }

  console.error("PolicySet SuperDocs route failed", error);
  return NextResponse.json(
    { error: "The SuperDocs operation could not be completed." },
    { status: 500 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
