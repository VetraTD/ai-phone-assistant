// About-page content. The owner supplies every OWNER_TODO string. While any
// remains, the page is not linked from the header or footer (it still renders
// at /about so the slots can be reviewed), and the build check
// `grep -rn OWNER_TODO src/site/content` must be empty before publishing.

export const ABOUT = {
  headline: "OWNER_TODO: one sentence on why Vetra exists",
  story: [
    "OWNER_TODO: paragraph 1 — what you saw happening to calls at small businesses and why that mattered to you.",
    "OWNER_TODO: paragraph 2 — how Vetra is run today: set up by hand with each business, UK first.",
  ],
  founders: [
    {
      name: "OWNER_TODO: founder name",
      role: "OWNER_TODO: role",
      bio: "OWNER_TODO: two or three sentences.",
      // Path under public/ once a photo is supplied, e.g. "/about/nithin.jpg"; null renders no image.
      photo: null,
    },
    {
      name: "OWNER_TODO: cofounder name",
      role: "OWNER_TODO: role",
      bio: "OWNER_TODO: two or three sentences.",
      photo: null,
    },
  ],
  // Facts that are already true and do not need the owner's input.
  facts: [
    "Set up by hand with every business, then live in 3 business days.",
    "UK first. Data is hosted in London.",
    "Calls are not recorded. Every call is transcribed and summarised in writing.",
  ],
};

export function isAboutReady() {
  return !JSON.stringify(ABOUT).includes("OWNER_TODO");
}
