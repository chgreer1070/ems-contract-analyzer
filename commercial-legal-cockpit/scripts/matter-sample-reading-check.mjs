import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(relative, "utf8");
const matterPage = read("app/matters/[id]/page.tsx");
const link = read("components/MatterSampleReadingLink.tsx");
const reading = read("app/reading/page.tsx");
const route = read("app/api/reading-sample/route.ts");
const client = read("lib/contracttwinCoreClient.ts");

assert.match(matterPage, /MatterSampleReadingLink/, "the matter screen must offer the sample reading");
assert.doesNotMatch(matterPage, /contracttwinCoreClient/, "the matter screen must not call the reading client");
assert.match(link, /Sample reading of a made-up agreement/);
assert.match(link, /href="\/reading"/);
assert.match(link, /not a Flex or customer contract/);
assert.match(link, /does not approve terms, send a notice, or change contract text/);
assert.match(link, /not an approval/);
assert.doesNotMatch(link, /contracttwinCoreClient|LEGAL_RELIANCE_ENABLED|\/api\/decisions|\/api\/decision-requests/);

assert.match(reading, /data-testid="sample-label"/);
assert.match(reading, /made-up agreement/);
assert.match(reading, /data-testid="disclaimer"/);
assert.match(reading, /data-testid="citation"/);
assert.match(reading, /data-testid="looked-at"/);
assert.match(reading, /This is not an approval/);
assert.match(reading, /does not send a notice or change contract text/);
assert.doesNotMatch(reading, /sixty \(60\)|LEGAL_RELIANCE_ENABLED|\/api\/decisions|\/api\/decision-requests/);

assert.match(route, /The reading service is not configured\./);
assert.match(route, /markAgreementLookedAt/);
assert.doesNotMatch(route, /LEGAL_RELIANCE_ENABLED|decision-requests|\/api\/decisions/);
assert.match(client, /not used by the cockpit's legal-reliance path/);

console.log("Matter sample-reading path checks passed.");
