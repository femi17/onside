// Minimal ambient types for @paystack/inline-js (v2) — the package ships no .d.ts. Covers only the
// newTransaction surface CheckoutClient uses (key/email/amount|plan/currency/metadata + callbacks).
declare module "@paystack/inline-js" {
  interface NewTransactionOptions {
    key: string;
    email: string;
    amount?: number;
    plan?: string;
    currency?: string;
    metadata?: Record<string, unknown>;
    onSuccess?: (transaction: { reference: string }) => void;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
    onLoad?: (response: unknown) => void;
    [key: string]: unknown;
  }
  export default class PaystackPop {
    newTransaction(options: NewTransactionOptions): unknown;
  }
}
