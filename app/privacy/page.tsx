import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Navbar } from "@/components/navbar"
import { Footer } from "@/components/footer"
import { COMPANY, CONTACT } from "@/lib/site"

/**
 * Privacy policy. Meta requires a public URL for it before the WhatsApp Business app
 * can be published, so this must stay a plain, login-free page that returns 200.
 *
 * The "website" and "cookies" sections describe what the site actually does, checked
 * against the source: the quote form only opens the visitor's own email app (nothing is
 * sent to a server), analytics is Vercel Web Analytics (cookieless), and the only thing
 * written to the browser is the light/dark choice in localStorage. If Google Analytics,
 * a newsletter, a chat widget or any other tracker is ever added, update those two
 * sections in the same change.
 *
 * The email address and company number come from lib/site.ts so this page follows them
 * if they change.
 */

const LAST_UPDATED = "14 November 2026"

const DESCRIPTION = "How Fonenova Ltd collects, uses and protects personal data on this website."

export const metadata: Metadata = {
  // Absolute, because the layout's "%s | FoneNova" template would otherwise add a second brand.
  title: { absolute: "Privacy Policy | Fonenova Ltd" },
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  // A page-level openGraph replaces the layout's rather than merging, so restate the image.
  openGraph: {
    title: "Privacy Policy | Fonenova Ltd",
    description: DESCRIPTION,
    url: "https://fonenova.com/privacy",
    siteName: "FoneNova",
    images: [{ url: "/images/og-cover.jpg", width: 1200, height: 630, alt: "FoneNova wholesale phones, tablets, laptops and accessories" }],
    locale: "en_GB",
    type: "website",
  },
  // Same reason: twitter metadata is also inherited from the layout, which would give
  // this page the homepage's title and description on a share card.
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy | Fonenova Ltd",
    description: DESCRIPTION,
    images: ["/images/og-cover.jpg"],
  },
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 flex flex-col gap-3">
      <h2 className="text-xl font-bold tracking-tight text-foreground font-mono">{title}</h2>
      {children}
    </section>
  )
}

function P({ children }: { children: ReactNode }) {
  return <p className="leading-relaxed text-muted-foreground">{children}</p>
}

function A({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="text-primary underline underline-offset-4 hover:opacity-80 transition-opacity"
    >
      {children}
    </a>
  )
}

function Term({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Navbar />

      <article className="mx-auto max-w-3xl px-6 pb-24 pt-36 lg:px-8">
        <h1 className="text-3xl font-bold tracking-tight text-balance font-mono sm:text-4xl">Privacy Policy</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

        <Section title="Who we are">
          <P>
            Fonenova Ltd is a company registered in Northern Ireland (company number {COMPANY.registrationNumber}).
            Registered office: Unit 7A-7B Weavers Court, Weavers Business Park, Belfast BT12 5GH, United Kingdom.
            Contact: <A href={`mailto:${CONTACT.email}`}>{CONTACT.email}</A>. Fonenova Ltd is the data controller for
            the personal data described here.
          </P>
        </Section>

        <Section title="Information we collect on this website">
          <ul className="flex list-disc flex-col gap-3 pl-5 leading-relaxed text-muted-foreground marker:text-primary">
            <li>
              <Term>Enquiry form.</Term> If you use the quote form, you enter your name, company name, email address,
              phone number (optional), product category, approximate quantity and any details you choose to add. The
              form does not send this information to our servers. When you press Send Enquiry it opens your own email
              app with a pre-filled message addressed to us, and we only receive it if you send that email. We use
              what you send to reply to your enquiry.
            </li>
            <li>
              <Term>Contacting us directly.</Term> If you email, phone or message us on WhatsApp, we receive the details
              you give us. On WhatsApp that includes your phone number, your WhatsApp profile name and the messages you
              send. WhatsApp is run by Meta, which handles the conversation under its own privacy policy. The WhatsApp
              button on this site is an ordinary link: nothing is shared with WhatsApp until you click it.
            </li>
            <li>
              <Term>Offer links.</Term> If we send you an offer by email, its link opens a private page that shows the
              offer and lets you accept or decline it. When you accept or decline, we record the time, your IP
              address, your browser details and any remarks you type, so that we have a record of who agreed to what
              and can protect the link from misuse. Each link can be answered once and expires, and these pages are
              not listed by search engines.
            </li>
            <li>
              <Term>Technical data.</Term> Our website host, Vercel, processes technical data such as your IP address,
              browser type and the pages requested, to deliver the site and keep it secure.
            </li>
            <li>
              <Term>Anonymous analytics.</Term> We use Vercel Web Analytics to count visits. It records the page
              viewed, the referring site, approximate location, device type, operating system and browser. Vercel
              describes it as anonymous: it does not use cookies, does not track you across other websites, and
              discards the visitor identifier after 24 hours.
            </li>
          </ul>
        </Section>

        <Section title="How we use information">
          <P>
            To respond to enquiries, run our business, keep accurate accounting and tax records, and meet our legal
            obligations.
          </P>
        </Section>

        <Section title="Legal basis">
          <P>
            Our legitimate interests in running and administering our business, and compliance with legal obligations
            (including UK tax law). Where we rely on consent, you can withdraw it at any time.
          </P>
        </Section>

        <Section title="Sharing">
          <P>
            We don&apos;t sell personal data. We share it only with service providers that help us operate (for
            example hosting, email, cloud storage and messaging providers such as Vercel, Google, Microsoft and
            Meta/WhatsApp), with our accountant, and with HM Revenue &amp; Customs or other authorities where the law
            requires it.
          </P>
        </Section>

        <Section title="International transfers">
          <P>
            Some of our providers may process data outside the UK. Where they do, appropriate safeguards are in place,
            such as UK adequacy regulations or standard contractual clauses.
          </P>
        </Section>

        <Section title="How long we keep it">
          <P>
            Enquiries: as long as needed to deal with them and any follow-up. Offer answers: the copy on this site is
            deleted after 90 days, and the record kept with the resulting order stays as long as that order&apos;s
            accounting records. Accounting and tax records, including receipts: at least 6 years, as UK tax law
            requires.
          </P>
        </Section>

        <Section title="Your rights">
          <P>
            Under UK data protection law you can ask to access, correct or delete your personal data, restrict or
            object to its use, or ask for a copy in a portable format. Email{" "}
            <A href={`mailto:${CONTACT.email}`}>{CONTACT.email}</A>. You can also complain to the Information
            Commissioner&apos;s Office (
            <A href="https://ico.org.uk" external>
              ico.org.uk
            </A>
            ).
          </P>
        </Section>

        <Section title="Cookies">
          <P>
            This website does not set any cookies, and we do not use advertising, social media or tracking cookies. Our
            analytics works without cookies, and it does not record the address of offer pages. If you switch between light and dark mode, your choice is saved in your
            browser&apos;s local storage so the site remembers it. This stays on your device and is never sent to us.
            You can clear it at any time in your browser settings.
          </P>
        </Section>

        <Section title="Changes">
          <P>We may update this policy. The date at the top shows when it last changed.</P>
        </Section>
      </article>

      <Footer />
    </main>
  )
}
