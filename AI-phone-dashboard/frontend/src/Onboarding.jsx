import { useState } from "react";
import { api } from "./api";
import { numberApi } from "./numberAPI";
import "./Onboarding.css";

export default function Onboarding({ existingBusiness, onBack, onComplete }) {
  const [name, setName] = useState(existingBusiness?.name || "");
  const [timezone, setTimezone] = useState(existingBusiness?.timezone || "America/Chicago");
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [greeting, setGreeting] = useState("Thank you for calling. How can I help you today?");
  const [afterHoursMode, setAfterHoursMode] = useState("take-message");
  const [transferPolicy, setTransferPolicy] = useState("business_hours_only");
  const [transferPhoneNumber, setTransferPhoneNumber] = useState("");
  const [notificationEmail, setNotificationEmail] = useState("");
  const [notificationPhone, setNotificationPhone] = useState("");
  const [generalInfo, setGeneralInfo] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateRegion, setStateRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [formStep, setFormStep] = useState(1);
  const TOTAL_FORM_STEPS = 3;

  const [businessId, setBusinessId] = useState(existingBusiness?.id || null);
  const [businessCreated, setBusinessCreated] = useState(!!existingBusiness);

  const [country, setCountry] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [numberType, setNumberType] = useState("local");

  const [searchingNumbers, setSearchingNumbers] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState([]);
  const [numbersError, setNumbersError] = useState("");

  const [buyingNumber, setBuyingNumber] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState("");

  const createBusiness = async (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await api.post("/api/onboarding/create-business", {
        name,
        timezone,
      });

      const createdBusinessId = res.data.business.id;

      if (!createdBusinessId) {
        throw new Error("Business created but no business ID was returned");
      }

      setBusinessId(createdBusinessId);

      // Save AI & call settings (same fields as Settings page)
      await api.put(`/api/business/${createdBusinessId}/settings`, {
        name,
        timezone,
        greeting_message: greeting,
        after_hours_policy: afterHoursMode,
        transfer_policy: transferPolicy,
        transfer_phone_number: transferPhoneNumber || "",
        notification_email: notificationEmail || "",
        notification_phone: notificationPhone || "",
        default_language: defaultLanguage,
        general_info: generalInfo || "",
        address_line1: addressLine1 || "",
        address_line2: addressLine2 || "",
        city: city || "",
        state_region: stateRegion || "",
        postal_code: postalCode || "",
      });

      setBusinessCreated(true);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to create business"
      );
    } finally {
      setLoading(false);
    }
  };

  const findNumbers = async () => {
    if (!businessId) return;

    setNumbersError("");
    setAvailableNumbers([]);
    setSearchingNumbers(true);

    try {
      const res = await numberApi.get(
        `/api/businesses/${businessId}/phone-numbers/available`,
        {
          params: {
            country,
            areaCode: areaCode.trim() || undefined,
            type: numberType,
          },
        }
      );

      setAvailableNumbers(res?.data?.numbers || []);
    } catch (err) {
      const serverMsg = err?.response?.data?.error;
      const noResponse =
        err?.code === "ERR_NETWORK" || err?.message === "Network Error";
      setNumbersError(
        serverMsg ||
          (noResponse
            ? "Could not reach the phone service. On your live site this is often CORS: the voice API (Railway) must allow https://www.vetratd.com (or redeploy after updating server CORS defaults)."
            : err?.message || "Failed to load available numbers")
      );
    } finally {
      setSearchingNumbers(false);
    }
  };

  const buyNumber = async (phoneNumber) => {
    if (!businessId || !phoneNumber) return;

    setNumbersError("");
    setBuyingNumber(true);
    setSelectedNumber(phoneNumber);

    try {
      await numberApi.post(`/api/businesses/${businessId}/phone-numbers/buy`, {
        phone_number: phoneNumber,
      });

      if (onComplete) {
        onComplete();
      }
    } catch (err) {
      setNumbersError(
        err?.response?.data?.error || "Failed to buy phone number"
      );
    } finally {
      setBuyingNumber(false);
      setSelectedNumber("");
    }
  };

  return (
    <div className="onboarding-page">
      <div className="onboarding-shell">
        <div className="onboarding-card">
          <div className="onboarding-top-row">
            {onBack ? (
              <button type="button" className="onboarding-back" onClick={onBack}>
                ← Back
              </button>
            ) : null}
            <div className="onboarding-badge">Business setup</div>
          </div>

          <div className="onboarding-header">
            <h1>Create your business</h1>
            <p>
              Set up your workspace so you can start tracking calls,
              appointments, and follow-ups from your dashboard.
            </p>
          </div>

          {!businessCreated ? (
            <form
              className="onboarding-form"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const tag = (e.target?.tagName || "").toLowerCase();
                if (tag === "textarea") return;
                // Never let Enter submit the form; only our explicit
                // button at the bottom is allowed to create the business.
                e.preventDefault();
                if (formStep < TOTAL_FORM_STEPS) {
                  setFormStep((s) => Math.min(TOTAL_FORM_STEPS, s + 1));
                }
              }}
            >
              <div className="onboarding-stepper" role="tablist" aria-label="Setup steps">
                {[1, 2, 3].map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={`onboarding-step-dot ${formStep === step ? "active" : ""}`}
                    onClick={() => setFormStep(step)}
                    aria-current={formStep === step ? "step" : undefined}
                    aria-label={`Step ${step} of ${TOTAL_FORM_STEPS}`}
                  >
                    {step}
                  </button>
                ))}
              </div>
              <div className="onboarding-step-label">
                Step {formStep} of {TOTAL_FORM_STEPS}
                {formStep === 1 && " — Basics"}
                {formStep === 2 && " — AI & calls"}
                {formStep === 3 && " — Details & address"}
              </div>

              {/* Step 1: Basics */}
              {formStep === 1 && (
                <div className="onboarding-step-content">
                  <div className="onboarding-field">
                    <label htmlFor="business-name">Business name</label>
                    <input
                      id="business-name"
                      type="text"
                      placeholder="e.g. Excel Cardiac Care"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="timezone">Timezone</label>
                    <select
                      id="timezone"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                    >
                      <option value="America/Chicago">America/Chicago</option>
                      <option value="America/New_York">America/New_York</option>
                      <option value="America/Los_Angeles">America/Los_Angeles</option>
                      <option value="Europe/London">Europe/London</option>
                    </select>
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="default-language">Preferred language</label>
                    <select
                      id="default-language"
                      value={defaultLanguage}
                      onChange={(e) => setDefaultLanguage(e.target.value)}
                    >
                      <option value="en">English</option>
                      <option value="es">Spanish</option>
                      <option value="fr">French</option>
                      <option value="de">German</option>
                      <option value="pt">Portuguese</option>
                      <option value="it">Italian</option>
                      <option value="nl">Dutch</option>
                      <option value="pl">Polish</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Step 2: AI & calls */}
              {formStep === 2 && (
                <div className="onboarding-step-content">
                  <div className="onboarding-field">
                    <label htmlFor="greeting">Greeting message</label>
                    <textarea
                      id="greeting"
                      rows={3}
                      placeholder="What callers hear when they call"
                      value={greeting}
                      onChange={(e) => setGreeting(e.target.value)}
                      className="onboarding-textarea"
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="after-hours">After-hours behaviour</label>
                    <select
                      id="after-hours"
                      value={afterHoursMode}
                      onChange={(e) => setAfterHoursMode(e.target.value)}
                    >
                      <option value="take-message">Take a message</option>
                      <option value="book-later">Book for later</option>
                      <option value="book_appointment">Book appointment</option>
                    </select>
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="transfer-policy">Transfer policy</label>
                    <select
                      id="transfer-policy"
                      value={transferPolicy}
                      onChange={(e) => setTransferPolicy(e.target.value)}
                    >
                      <option value="never">Never transfer</option>
                      <option value="always">Always transfer</option>
                      <option value="business_hours_only">Business hours only</option>
                    </select>
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="transfer-phone">Transfer phone number (optional)</label>
                    <input
                      id="transfer-phone"
                      type="text"
                      placeholder="e.g. +18552700615"
                      value={transferPhoneNumber}
                      onChange={(e) => setTransferPhoneNumber(e.target.value)}
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="notification-email">Notification email (optional)</label>
                    <input
                      id="notification-email"
                      type="email"
                      placeholder="you@business.com"
                      value={notificationEmail}
                      onChange={(e) => setNotificationEmail(e.target.value)}
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="notification-phone">Notification phone (optional)</label>
                    <input
                      id="notification-phone"
                      type="text"
                      placeholder="e.g. +14699338887"
                      value={notificationPhone}
                      onChange={(e) => setNotificationPhone(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {/* Step 3: Details & address */}
              {formStep === 3 && (
                <div className="onboarding-step-content">
                  <div className="onboarding-field">
                    <label htmlFor="general-info">General info (optional)</label>
                    <textarea
                      id="general-info"
                      rows={2}
                      placeholder="e.g. Excel Cardiac Care is a specialized medical practice."
                      value={generalInfo}
                      onChange={(e) => setGeneralInfo(e.target.value)}
                      className="onboarding-textarea"
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="address-line1">Address line 1 (optional)</label>
                    <input
                      id="address-line1"
                      type="text"
                      placeholder="e.g. 4400 Heritage Trace Pkwy, #208"
                      value={addressLine1}
                      onChange={(e) => setAddressLine1(e.target.value)}
                    />
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="address-line2">Address line 2 (optional)</label>
                    <input
                      id="address-line2"
                      type="text"
                      placeholder="Optional"
                      value={addressLine2}
                      onChange={(e) => setAddressLine2(e.target.value)}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div className="onboarding-field">
                      <label htmlFor="city">City (optional)</label>
                      <input
                        id="city"
                        type="text"
                        placeholder="e.g. Keller"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                      />
                    </div>
                    <div className="onboarding-field">
                      <label htmlFor="state-region">State / Region (optional)</label>
                      <input
                        id="state-region"
                        type="text"
                        placeholder="e.g. Texas"
                        value={stateRegion}
                        onChange={(e) => setStateRegion(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="onboarding-field">
                    <label htmlFor="postal-code">Postal code (optional)</label>
                    <input
                      id="postal-code"
                      type="text"
                      placeholder="e.g. 76244"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {error ? <div className="onboarding-error">{error}</div> : null}

              <div className="onboarding-form-actions">
                {formStep > 1 ? (
                  <button
                    type="button"
                    className="onboarding-button secondary"
                    onClick={() => setFormStep(formStep - 1)}
                  >
                    ← Back
                  </button>
                ) : (
                  <span />
                )}
                <div className="onboarding-form-actions-primary">
                  {formStep < TOTAL_FORM_STEPS ? (
                    <button
                      type="button"
                      className="onboarding-button"
                      onClick={() => setFormStep(formStep + 1)}
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      className="onboarding-button"
                      type="button"
                      disabled={loading}
                      onClick={() => createBusiness()}
                    >
                      {loading ? "Creating business..." : "Create Business"}
                    </button>
                  )}
                </div>
              </div>
            </form>
          ) : (
            <div className="onboarding-form">
              <div className="onboarding-success">
                Business created successfully. Now choose a phone number.
              </div>

              <div className="onboarding-field">
                <label htmlFor="country">Country</label>
                <select
                  id="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                >
                  <option value="US">United States</option>
                </select>
              </div>

              <div className="onboarding-field">
                <label htmlFor="area-code">Area code (optional)</label>
                <input
                  id="area-code"
                  type="text"
                  placeholder="e.g. 512"
                  value={areaCode}
                  onChange={(e) => setAreaCode(e.target.value)}
                />
              </div>

              <div className="onboarding-field">
                <label htmlFor="number-type">Number type</label>
                <select
                  id="number-type"
                  value={numberType}
                  onChange={(e) => setNumberType(e.target.value)}
                >
                  <option value="local">Local</option>
                  <option value="toll-free">Toll-free</option>
                </select>
              </div>

              <button
                type="button"
                className="onboarding-button"
                disabled={searchingNumbers}
                onClick={findNumbers}
              >
                {searchingNumbers ? "Finding numbers..." : "Find Numbers"}
              </button>

              {numbersError ? (
                <div className="onboarding-error">{numbersError}</div>
              ) : null}

              {availableNumbers.length > 0 ? (
                <div className="number-results">
                  <div className="number-results-title">Available numbers</div>

                  <div className="number-results-list">
                    {availableNumbers.map((num) => (
                      <div
                        key={num.phone_number}
                        className="number-result-card"
                      >
                        <div className="number-result-info">
                          <div className="number-result-phone">
                            {num.friendly_name || num.phone_number}
                          </div>
                          <div className="number-result-meta">
                            {num.phone_number}
                            {num.locality ? ` • ${num.locality}` : ""}
                          </div>
                        </div>

                        <button
                          type="button"
                          className="number-buy-button"
                          disabled={buyingNumber}
                          onClick={() => buyNumber(num.phone_number)}
                        >
                          {buyingNumber && selectedNumber === num.phone_number
                            ? "Buying..."
                            : "Buy this number"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}