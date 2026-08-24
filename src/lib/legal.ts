/**
 * Single source of truth for the Privacy Policy and the Terms & Conditions.
 *
 * The same content is rendered in three places — the standalone /privacy and /terms
 * pages, and the reader modal inside the auth sheet — so the text lives here rather
 * than in any one of them.  Consent is captured once, at sign-up, and stamped onto the
 * account as `LEGAL_VERSION`: bump it whenever the substance of either document
 * changes, and each account then carries the version it actually agreed to.
 */

export const LEGAL_VERSION = "2026-08-24";

/** Human-readable form of LEGAL_VERSION, shown at the head of each document. */
export const LEGAL_EFFECTIVE_DATE = "24 August 2026";

/** Operator of the platform, as named throughout both documents. */
export const LEGAL_ENTITY = "CourtHub";

/** Reachable today; swap for legal@ / privacy@ aliases if those are set up later. */
export const LEGAL_CONTACT_EMAIL = "hello@courthub.ph";

export type LegalBlock = string | { list: string[] };

export type LegalSection = {
  /** Anchor target, also the key used for the on-page contents list. */
  id: string;
  heading: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  kicker: string;
  title: string;
  summary: string;
  sections: LegalSection[];
};

export const TERMS: LegalDocument = {
  kicker: "Legal",
  title: "Terms & Conditions",
  summary:
    `These Terms govern your access to and use of the ${LEGAL_ENTITY} platform. Please read them ` +
    `carefully — by creating an account or signing in you enter into a binding agreement with us.`,
  sections: [
    {
      id: "acceptance",
      heading: "1. Acceptance of these Terms",
      blocks: [
        `By creating a ${LEGAL_ENTITY} account and ticking the agreement box presented at sign-up, ` +
          `or by otherwise accessing the platform, you confirm that you have read, understood and ` +
          `agree to be bound by these Terms and by our Privacy Policy, which forms part of this ` +
          `agreement. Each time you sign in afterwards you continue to be bound by the version of ` +
          `these Terms then in force, which is always available from the sign-in screen and in the ` +
          `footer of the site.`,
        `If you do not agree to any part of these Terms, you must not create an account or use the ` +
          `platform. If you are agreeing on behalf of a company, venue or other organisation, you ` +
          `confirm that you are authorised to bind that organisation to these Terms.`,
        `You must be at least 18 years old, or have the consent of a parent or legal guardian who ` +
          `accepts these Terms on your behalf, to hold an account.`,
      ],
    },
    {
      id: "service",
      heading: "2. The service we provide",
      blocks: [
        `${LEGAL_ENTITY} is a booking and venue-management platform. It lets players discover sports ` +
          `courts, check availability and make reservations, and it gives venue managers ("Tenants") ` +
          `tools to list courts, publish rates and operating hours, and manage the bookings they receive.`,
        `${LEGAL_ENTITY} is a facilitator, not a provider of sporting facilities. The contract for the ` +
          `use of any court is between the player and the venue. We do not own, operate, inspect or ` +
          `control the venues listed on the platform, and we are not responsible for the condition, ` +
          `safety, legality or quality of any facility.`,
        `We may add, change, suspend or withdraw features at any time in order to develop and maintain ` +
          `the service. We will give reasonable notice of any change that materially reduces the ` +
          `functionality available to you.`,
      ],
    },
    {
      id: "accounts",
      heading: "3. Your account",
      blocks: [
        `You must give accurate, current and complete information when you register, and keep it up to ` +
          `date. You are responsible for everything that happens under your account.`,
        {
          list: [
            "Keep your password confidential and do not share your account with anyone else.",
            "Tell us promptly at " + LEGAL_CONTACT_EMAIL + " if you suspect unauthorised access.",
            "Do not create an account using another person's identity or a false identity.",
            "Do not operate multiple accounts to evade limits, suspensions or cancellation rules.",
          ],
        },
        `We may suspend or close an account that breaches these Terms, that is used unlawfully, or that ` +
          `presents a risk to other users, to venues or to the platform.`,
      ],
    },
    {
      id: "bookings",
      heading: "4. Bookings, payments and cancellations",
      blocks: [
        `Rates, availability and operating hours are set and maintained by each venue. A booking is ` +
          `confirmed only once it is shown as confirmed in the platform, and remains subject to the ` +
          `venue's own house rules.`,
        `Payments made through the platform are processed by our third-party payment provider. We do ` +
          `not store your full card details. Any fees payable to ${LEGAL_ENTITY} will be disclosed to ` +
          `you before you complete a booking.`,
        `Cancellation and refund entitlements depend on the venue's stated policy and on when the ` +
          `cancellation is made. Where a refund is due it is returned through the original payment ` +
          `method, and the time it takes to appear is determined by your bank or payment provider.`,
        `Repeated failure to attend confirmed bookings ("no-shows") may result in restrictions on your ` +
          `ability to book.`,
      ],
    },
    {
      id: "conduct",
      heading: "5. Acceptable use",
      blocks: [
        "When using the platform you agree that you will not:",
        {
          list: [
            "Use the platform for any unlawful purpose, or in breach of any applicable law or regulation.",
            "Post false, misleading, defamatory, harassing, obscene or discriminatory content, or content you do not have the right to share.",
            "Make speculative, fraudulent or bad-faith bookings, or interfere with another user's bookings.",
            "Attempt to gain unauthorised access to any account, server, database or part of the platform.",
            "Introduce malware, or otherwise damage, disable or impair the operation of the platform.",
            "Place a disproportionate load on our infrastructure, or circumvent any rate limit, access control or security measure.",
          ],
        },
      ],
    },
    {
      id: "ip",
      heading: "6. Intellectual property",
      blocks: [
        `The platform — including its software, source code, databases, design, layout, user interface, ` +
          `graphics, text, logos and the ${LEGAL_ENTITY} name — is owned by ${LEGAL_ENTITY} or its ` +
          `licensors and is protected by copyright, trade mark and other intellectual property laws, ` +
          `including the Intellectual Property Code of the Philippines (Republic Act No. 8293).`,
        `Subject to your compliance with these Terms, we grant you a limited, personal, non-exclusive, ` +
          `non-transferable and revocable licence to access and use the platform for its intended ` +
          `purpose. No other right is granted. Any rights not expressly granted are reserved.`,
        `Content that you upload remains yours. By uploading it you grant ${LEGAL_ENTITY} a worldwide, ` +
          `royalty-free licence to host, store, reproduce and display that content for the purpose of ` +
          `operating and promoting the platform. You confirm that you hold the rights necessary to ` +
          `grant that licence.`,
      ],
    },
    {
      id: "reverse-engineering",
      heading: "7. Restrictions on reverse engineering and replication",
      blocks: [
        `You acknowledge that the platform embodies confidential and proprietary know-how of ` +
          `${LEGAL_ENTITY} — not only its code, but the concept, business logic, booking and pricing ` +
          `models, workflow design and the overall flow and structure of the system. These are the ` +
          `product of substantial investment and are protected as intellectual property and as trade ` +
          `secrets.`,
        `Except to the strict extent that the restriction is prohibited by applicable law, you must not, ` +
          `and must not permit or assist any other person to:`,
        {
          list: [
            "Reverse engineer, decompile, disassemble, decrypt or otherwise attempt to derive the source code, object code, algorithms, data model or underlying structure of any part of the platform.",
            "Copy, reproduce, adapt, translate or create derivative works from the platform, its interface, its design or its documentation.",
            "Replicate, imitate or reconstruct the concept, workflow, process flow, feature set, screen sequence or system logic of the platform in any competing or comparable product or service.",
            "Access the platform in order to build, benchmark for the purpose of building, or assist a third party to build, a similar or competing product or service.",
            "Use any robot, spider, scraper, crawler, automated script, headless browser or other automated means to access, monitor, extract or index the platform, its listings, its rates or its data, except with our prior written consent.",
            "Access or use any undocumented interface or internal application programming interface, or interact with the platform other than through the user interface and interfaces we provide for that purpose.",
            "Remove, obscure or alter any proprietary notice, watermark, attribution or identifier displayed on or within the platform.",
            "Disclose to any third party any non-public information about the platform's design, architecture, workflow or operation that you learn through your use of it.",
          ],
        },
        `These restrictions survive the closure of your account and the termination of this agreement. ` +
          `We take breaches seriously: as well as suspending or closing your account, we may pursue ` +
          `injunctive relief and any other remedy available to us in law or in equity, and damages ` +
          `alone may not be an adequate remedy for a breach of this section.`,
        `If you have a legitimate interoperability or security-research need, contact us at ` +
          `${LEGAL_CONTACT_EMAIL} before taking any action. We would rather work with you than take ` +
          `action against you.`,
      ],
    },
    {
      id: "tenants",
      heading: "8. Additional terms for venue managers",
      blocks: [
        `If you register as a Tenant, you additionally confirm that you are authorised to list and ` +
          `commercialise the courts you publish, and that you hold the permits, licences and insurance ` +
          `required to operate them.`,
        {
          list: [
            "Keep your listings, rates, availability and operating hours accurate and current.",
            "Honour confirmed bookings, and handle cancellations in line with the policy you publish.",
            "Comply with all applicable safety, tax, employment and consumer-protection obligations.",
            "Upload only images and descriptions that you own or are licensed to use.",
          ],
        },
        `You are solely responsible for your venue, its facilities and its dealings with players. You ` +
          `agree to indemnify ${LEGAL_ENTITY} against any claim arising from your listings, your ` +
          `facilities or your conduct.`,
      ],
    },
    {
      id: "availability",
      heading: "9. Availability of the platform",
      blocks: [
        `We work to keep the platform available, but we do not guarantee uninterrupted or error-free ` +
          `operation. Access may be suspended for maintenance, upgrades, or reasons outside our ` +
          `control, including failures of networks, hosting providers or payment processors.`,
        `The platform is provided on an "as is" and "as available" basis. To the fullest extent ` +
          `permitted by law we exclude all warranties, conditions and representations that are not ` +
          `expressly set out in these Terms.`,
      ],
    },
    {
      id: "liability",
      heading: "10. Limitation of liability",
      blocks: [
        `Nothing in these Terms limits liability that cannot be limited by law, including liability for ` +
          `death or personal injury caused by negligence, or for fraud.`,
        `Subject to that, ${LEGAL_ENTITY} is not liable for indirect or consequential loss, loss of ` +
          `profit, loss of business or opportunity, or loss of data, and our total liability arising out ` +
          `of or in connection with the platform is limited to the greater of the total fees you paid ` +
          `to ${LEGAL_ENTITY} in the three months before the event giving rise to the claim, or ` +
          `PHP 5,000.`,
        `We are not liable for the acts or omissions of any venue, player or payment provider, or for ` +
          `any injury, loss or damage suffered at a venue.`,
      ],
    },
    {
      id: "termination",
      heading: "11. Suspension and termination",
      blocks: [
        `You may close your account at any time by contacting us. We may suspend or terminate your ` +
          `access immediately where you breach these Terms, where we are required to do so by law, or ` +
          `where continued access presents a risk to the platform or to other users.`,
        `Termination does not affect bookings already confirmed, amounts already due, or any provision ` +
          `of these Terms intended to survive it — including sections 6, 7, 10 and 13.`,
      ],
    },
    {
      id: "changes",
      heading: "12. Changes to these Terms",
      blocks: [
        `We may update these Terms as the platform and the law develop. When we make a material change ` +
          `we will publish the revised version here with a new effective date and notify account ` +
          `holders by email or in the platform. Continuing to use the platform after the revised ` +
          `version takes effect means you accept it. If you do not accept a change, you may close ` +
          `your account.`,
      ],
    },
    {
      id: "law",
      heading: "13. Governing law and disputes",
      blocks: [
        `These Terms are governed by the laws of the Republic of the Philippines. The courts of the ` +
          `Philippines have exclusive jurisdiction over any dispute arising out of them, without ` +
          `prejudice to any mandatory consumer protection you enjoy where you live.`,
        `If any provision of these Terms is found to be unenforceable, the remaining provisions continue ` +
          `in full force.`,
      ],
    },
    {
      id: "contact-terms",
      heading: "14. Contact",
      blocks: [
        `Questions about these Terms can be sent to ${LEGAL_CONTACT_EMAIL}. Please include the email ` +
          `address associated with your account so that we can help you more quickly.`,
      ],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  kicker: "Legal",
  title: "Privacy Policy",
  summary:
    `This Policy explains what personal data ${LEGAL_ENTITY} collects, why we collect it, who we ` +
    `share it with and the rights you have over it. We handle personal data in accordance with the ` +
    `Data Privacy Act of 2012 (Republic Act No. 10173) and its implementing rules.`,
  sections: [
    {
      id: "who-we-are",
      heading: "1. Who we are",
      blocks: [
        `${LEGAL_ENTITY} operates a platform that connects players with sports venues and gives venue ` +
          `managers tools to run their courts. For the personal data described in this Policy, ` +
          `${LEGAL_ENTITY} acts as the personal information controller. You can reach us — including ` +
          `our Data Protection Officer — at ${LEGAL_CONTACT_EMAIL}.`,
      ],
    },
    {
      id: "what-we-collect",
      heading: "2. What we collect",
      blocks: [
        `Using ${LEGAL_ENTITY} requires an account, created through the sign-up form and reached ` +
          `afterwards by signing in. We collect only the information necessary to create, ` +
          `authenticate and maintain that account and to provide the services offered through the ` +
          `platform:`,
        {
          list: [
            "Account data — your name, email address, password (stored only as a secure hash), optional phone number, and whether you registered as a player or a venue manager.",
            "Consent data — the version of these documents you agreed to when you created your account, and the date you agreed, kept as our record that consent was given.",
            "Booking data — the courts you book, the dates and times, the amount charged, and the status and history of each reservation.",
            "Payment data — the record of a transaction and its reference. Card and wallet details are collected and held by our payment provider, not by us.",
            "Venue data — for venue managers, the listings, rates, operating hours, images and location details you publish.",
            "Communications — messages you exchange through the platform's booking chat, and any enquiry you send us.",
            "Location data — an approximate or precise location, used to show courts near you. This is requested through your browser and only used if you allow it.",
            "Technical data — IP address, device and browser type, pages viewed and error diagnostics, collected so we can keep the platform secure and working.",
          ],
        },
        `We do not knowingly collect sensitive personal information, and we do not collect data from ` +
          `children under 18 without the consent of a parent or guardian.`,
      ],
    },
    {
      id: "why-we-use",
      heading: "3. Why we use it, and on what basis",
      blocks: [
        {
          list: [
            "To create and administer your account, and to authenticate you — necessary to perform our contract with you.",
            "To take, confirm, modify and cancel bookings, and to process payments and refunds — necessary to perform that contract.",
            "To send service messages such as booking confirmations, reminders, changes and receipts — necessary to perform that contract.",
            "To keep the platform secure, prevent fraud and abuse, and diagnose faults — our legitimate interest in a safe and reliable service.",
            "To understand which features are used so we can improve them — our legitimate interest, using aggregated data wherever possible.",
            "To show you courts near you — with your consent, which you can withdraw in your browser at any time.",
            "To meet accounting, tax and other legal obligations — compliance with law.",
          ],
        },
        `We do not sell your personal data, and we do not use it for automated decision-making that ` +
          `produces legal effects for you.`,
      ],
    },
    {
      id: "sharing",
      heading: "4. Who we share it with",
      blocks: [
        {
          list: [
            "Venues — when you book a court, the venue receives the details it needs to honour the reservation, such as your name, contact details and booking time.",
            "Service providers — our hosting, database, email, mapping and payment providers, who process data only on our instructions and under written safeguards.",
            "Authorities — where disclosure is required by law, court order or a lawful request from a public authority.",
            "A successor — if the business is reorganised, merged or acquired, subject to the protections in this Policy.",
          ],
        },
        `Some of our providers process data outside the Philippines. Where they do, we take the ` +
          `measures required by the Data Privacy Act to ensure your data continues to be protected.`,
      ],
    },
    {
      id: "confidentiality",
      heading: "5. Confidentiality and limits on disclosure",
      blocks: [
        `We do not publicly display, publish, rent or sell your personal information, and we do not ` +
          `make your account details visible to other users of the platform.`,
        `We disclose personal information outside ${LEGAL_ENTITY} only in the circumstances set out ` +
          `in section 4 above, namely:`,
        {
          list: [
            "To the venue you book with, and only the details it needs to honour your reservation.",
            "To the service providers who operate the platform on our behalf, who may use it only on our instructions and may not use it for their own purposes.",
            "Where disclosure is required by applicable law, regulation, legal process or a lawful request from a public authority.",
            "Where it is necessary to protect the security and integrity of the platform, or the rights and safety of our users, our venues or the public.",
          ],
        },
        `Your account information is otherwise treated as confidential. It is used only for ` +
          `legitimate purposes connected with operating, maintaining, securing and improving the ` +
          `platform and the services provided through it, and not for any unrelated purpose without ` +
          `telling you first.`,
      ],
    },
    {
      id: "retention",
      heading: "6. How long we keep it",
      blocks: [
        `We keep account data for as long as your account is open. When you close it we delete or ` +
          `anonymise your personal data within a reasonable period, except where we must keep records ` +
          `longer — booking and payment records are retained for the period required by tax and ` +
          `accounting law, and limited records may be kept where needed to resolve a dispute or enforce ` +
          `our agreements.`,
      ],
    },
    {
      id: "security",
      heading: "7. How we protect it",
      blocks: [
        `We take reasonable and appropriate organisational, physical and technical measures to ` +
          `protect your personal information against unauthorised access, alteration, disclosure, ` +
          `loss and destruction.`,
        `In practice that means encryption in transit, hashed password storage, role-based access ` +
          `controls and row-level database security so that each account can reach only the data it ` +
          `is entitled to. Access by our staff is limited to those who need it to operate the service.`,
        `No system is perfectly secure. If a breach occurs that is likely to put your rights at ` +
          `serious risk, we will notify you and the National Privacy Commission as required by law.`,
      ],
    },
    {
      id: "rights",
      heading: "8. Your rights",
      blocks: [
        "Under the Data Privacy Act you have the right to:",
        {
          list: [
            "Be informed about how your personal data is processed.",
            "Access the personal data we hold about you.",
            "Have inaccurate or incomplete data corrected.",
            "Object to processing, or withdraw a consent you previously gave.",
            "Have your data erased or blocked where the law allows.",
            "Receive a copy of your data in a portable, machine-readable format.",
            "Be indemnified for damage caused by inaccurate, false or unlawfully obtained data.",
            "Lodge a complaint with the National Privacy Commission.",
          ],
        },
        `To exercise any of these, write to ${LEGAL_ENTITY} at ${LEGAL_CONTACT_EMAIL} from the email ` +
          `address on your account. We respond within the period required by law, and we may need to ` +
          `verify your identity first.`,
      ],
    },
    {
      id: "cookies",
      heading: "9. Cookies and local storage",
      blocks: [
        `We use cookies and browser storage that are necessary for the platform to work — keeping you ` +
          `signed in, holding your session, and remembering your interface preferences. We also use ` +
          `limited analytics to understand how the platform is used. You can clear or block this ` +
          `storage in your browser, though parts of the platform will stop working if you do.`,
      ],
    },
    {
      id: "third-party",
      heading: "10. Third-party services",
      blocks: [
        `The platform embeds maps and processes payments through third parties. When you use those ` +
          `features, the provider handles your data under its own privacy policy, which we recommend ` +
          `you read. We are not responsible for the privacy practices of any site we link to.`,
      ],
    },
    {
      id: "changes-privacy",
      heading: "11. Changes to this Policy",
      blocks: [
        `We will update this Policy when our practices or the law change. The revised version is ` +
          `published here with a new effective date, and where a change is material we will notify ` +
          `account holders by email or in the platform before it takes effect.`,
      ],
    },
    {
      id: "contact-privacy",
      heading: "12. Contact us",
      blocks: [
        `For any question about this Policy or about how we handle your data, write to ` +
          `${LEGAL_CONTACT_EMAIL}. If you are not satisfied with our response, you may complain to the ` +
          `National Privacy Commission of the Philippines.`,
      ],
    },
  ],
};
