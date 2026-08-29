export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.ignores.add("src/admin/**");
  eleventyConfig.addPassthroughCopy({ "src/_headers": "_headers" });
  eleventyConfig.addPassthroughCopy("src/robots.txt");

  eleventyConfig.addCollection("authorList", (c) =>
    c.getFilteredByTag("authors").sort((a, b) => (a.data.order || 0) - (b.data.order || 0))
  );

  eleventyConfig.addCollection("postList", (c) =>
    c.getFilteredByTag("posts").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addFilter("readableDate", (d) =>
    new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
  );

  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString().slice(0, 10));

  eleventyConfig.addFilter("initial", (s) => (s || "?").trim().charAt(0).toUpperCase());

  // Turn a plain-text field with blank lines into paragraphs.
  eleventyConfig.addFilter("paragraphs", (s) =>
    (s || "")
      .split(/\n\s*\n/)
      .map((p) => `<p>${p.trim().replace(/\n/g, "<br>")}</p>`)
      .join("\n")
  );

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
