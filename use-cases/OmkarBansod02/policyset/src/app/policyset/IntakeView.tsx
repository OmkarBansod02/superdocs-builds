import type { ReactNode } from "react";
import type { ReturnShippingPayer } from "@/domain";
import {
  ListField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  ToggleField,
} from "./fields";
import type { IntakeFormState } from "./intake";

const RETURN_PAYER_OPTIONS = [
  { value: "customer", label: "Customer" },
  { value: "merchant", label: "Merchant" },
] as const;

export function IntakeView({
  value,
  error,
  onChange,
  onGenerate,
}: {
  value: IntakeFormState;
  error: string | null;
  onChange: (next: IntakeFormState) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="app-frame">
      <header className="chrome">
        <div className="chrome-identity">
          <p className="brand">PolicySet</p>
          <p className="chrome-subtitle">Guided intake for a physical-goods store</p>
        </div>
        <button className="primary-button" type="button" onClick={onGenerate}>
          Generate Policy Set
        </button>
      </header>

      <main className="intake">
        <p className="intake-lead">
          Northstar Goods is prefilled. Change any facts, then generate the four
          synchronized documents.
        </p>

        {error ? <p className="intake-error">{error}</p> : null}

        <form
          className="intake-form"
          onSubmit={(event) => {
            event.preventDefault();
            onGenerate();
          }}
        >
          <Section n="01" title="Company">
            <TextField
              label="Legal name"
              value={value.company.legalName}
              onChange={(legalName) =>
                patchCompany(value, onChange, { legalName })
              }
            />
            <TextField
              label="Website"
              type="url"
              value={value.company.website}
              onChange={(website) => patchCompany(value, onChange, { website })}
            />
            <TextField
              label="Support email"
              type="email"
              value={value.company.supportEmail}
              onChange={(supportEmail) =>
                patchCompany(value, onChange, { supportEmail })
              }
            />
            <TextField
              label="Effective date"
              type="date"
              value={value.company.effectiveDate}
              onChange={(effectiveDate) =>
                patchCompany(value, onChange, { effectiveDate })
              }
            />
            <div className="field-span-2">
              <TextField
                label="Governing jurisdiction"
                value={value.company.governingJurisdiction}
                onChange={(governingJurisdiction) =>
                  patchCompany(value, onChange, { governingJurisdiction })
                }
              />
            </div>
            <div className="field-span-2 address-block">
              <TextField
                label="Street address"
                value={value.company.mailingAddress.line1}
                onChange={(line1) =>
                  patchAddress(value, onChange, { line1 })
                }
              />
              <div className="address-row">
                <TextField
                  label="City"
                  value={value.company.mailingAddress.city}
                  onChange={(city) =>
                    patchAddress(value, onChange, { city })
                  }
                />
                <TextField
                  label="Region"
                  value={value.company.mailingAddress.region}
                  onChange={(region) =>
                    patchAddress(value, onChange, { region })
                  }
                />
                <TextField
                  label="Postal code"
                  value={value.company.mailingAddress.postalCode}
                  onChange={(postalCode) =>
                    patchAddress(value, onChange, { postalCode })
                  }
                />
                <TextField
                  label="Country"
                  value={value.company.mailingAddress.country}
                  onChange={(country) =>
                    patchAddress(value, onChange, { country })
                  }
                />
              </div>
            </div>
          </Section>

          <Section n="02" title="Store">
            <NumberField
              label="Minimum customer age"
              value={value.store.minimumCustomerAge}
              onChange={(minimumCustomerAge) =>
                patchStore(value, onChange, { minimumCustomerAge })
              }
            />
            <TextField
              label="Payment processor"
              value={value.store.paymentProcessor}
              onChange={(paymentProcessor) =>
                patchStore(value, onChange, { paymentProcessor })
              }
            />
            <div className="field-span-2">
              <ListField
                label="Shipping regions"
                value={value.store.shippingRegions}
                onChange={(shippingRegions) =>
                  patchStore(value, onChange, { shippingRegions })
                }
              />
            </div>
          </Section>

          <Section n="03" title="Returns & Warranty">
            <NumberField
              label="Return window (days)"
              value={value.returns.windowDays}
              onChange={(windowDays) =>
                patchReturns(value, onChange, { windowDays })
              }
            />
            <NumberField
              label="Refund processing (days)"
              value={value.returns.processingDays}
              onChange={(processingDays) =>
                patchReturns(value, onChange, { processingDays })
              }
            />
            <SelectField
              label="Return shipping paid by"
              value={value.returns.returnShippingPayer}
              options={RETURN_PAYER_OPTIONS}
              onChange={(returnShippingPayer) =>
                patchReturns(value, onChange, {
                  returnShippingPayer: returnShippingPayer as ReturnShippingPayer,
                })
              }
            />
            <TextField
              label="Refund method"
              value={value.returns.refundMethod}
              onChange={(refundMethod) =>
                patchReturns(value, onChange, { refundMethod })
              }
            />
            <div className="field-span-2">
              <TextAreaField
                label="Return condition"
                value={value.returns.eligibleCondition}
                onChange={(eligibleCondition) =>
                  patchReturns(value, onChange, { eligibleCondition })
                }
              />
            </div>
            <div className="field-span-2">
              <ListField
                label="Final-sale exceptions"
                value={value.returns.finalSaleExceptions}
                onChange={(finalSaleExceptions) =>
                  patchReturns(value, onChange, { finalSaleExceptions })
                }
              />
            </div>
            <NumberField
              label="Warranty duration (months)"
              value={value.warranty.durationMonths}
              onChange={(durationMonths) =>
                patchWarranty(value, onChange, { durationMonths })
              }
            />
            <TextField
              label="Covered defects"
              value={value.warranty.coveredDefects}
              onChange={(coveredDefects) =>
                patchWarranty(value, onChange, { coveredDefects })
              }
            />
            <div className="field-span-2">
              <TextAreaField
                label="Warranty exclusions"
                value={value.warranty.exclusions}
                onChange={(exclusions) =>
                  patchWarranty(value, onChange, { exclusions })
                }
              />
            </div>
            <div className="field-span-2">
              <TextAreaField
                label="How to claim warranty"
                value={value.warranty.claimMethod}
                onChange={(claimMethod) =>
                  patchWarranty(value, onChange, { claimMethod })
                }
              />
            </div>
          </Section>

          <Section n="04" title="Privacy">
            <div className="field-span-2">
              <ListField
                label="Data collected"
                value={value.privacy.collectedDataCategories}
                onChange={(collectedDataCategories) =>
                  patchPrivacy(value, onChange, { collectedDataCategories })
                }
              />
            </div>
            <div className="field-span-2">
              <ListField
                label="Use purposes"
                value={value.privacy.purposes}
                onChange={(purposes) =>
                  patchPrivacy(value, onChange, { purposes })
                }
              />
            </div>
            <div className="field-span-2">
              <ListField
                label="Processors and services"
                value={value.privacy.processors}
                onChange={(processors) =>
                  patchPrivacy(value, onChange, { processors })
                }
              />
            </div>
            <TextField
              label="Retention"
              value={value.privacy.retentionSummary}
              onChange={(retentionSummary) =>
                patchPrivacy(value, onChange, { retentionSummary })
              }
            />
            <div className="toggle-row">
              <ToggleField
                label="Analytics enabled"
                checked={value.privacy.analyticsEnabled}
                onChange={(analyticsEnabled) =>
                  patchPrivacy(value, onChange, { analyticsEnabled })
                }
              />
              <ToggleField
                label="Marketing enabled"
                checked={value.privacy.marketingEnabled}
                onChange={(marketingEnabled) =>
                  patchPrivacy(value, onChange, { marketingEnabled })
                }
              />
            </div>
          </Section>

          <div className="intake-footer">
            <button className="primary-button" type="submit">
              Generate Policy Set
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Section({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="intake-section">
      <header className="intake-section-header">
        <span className="intake-section-n">{n}</span>
        <h2>{title}</h2>
      </header>
      <div className="intake-fields">{children}</div>
    </section>
  );
}

function patchCompany(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["company"]>,
) {
  onChange({ ...value, company: { ...value.company, ...patch } });
}

function patchAddress(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["company"]["mailingAddress"]>,
) {
  onChange({
    ...value,
    company: {
      ...value.company,
      mailingAddress: { ...value.company.mailingAddress, ...patch },
    },
  });
}

function patchStore(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["store"]>,
) {
  onChange({ ...value, store: { ...value.store, ...patch } });
}

function patchReturns(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["returns"]>,
) {
  onChange({ ...value, returns: { ...value.returns, ...patch } });
}

function patchWarranty(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["warranty"]>,
) {
  onChange({ ...value, warranty: { ...value.warranty, ...patch } });
}

function patchPrivacy(
  value: IntakeFormState,
  onChange: (next: IntakeFormState) => void,
  patch: Partial<IntakeFormState["privacy"]>,
) {
  onChange({ ...value, privacy: { ...value.privacy, ...patch } });
}
