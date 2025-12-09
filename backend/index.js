const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Fetch HTML from URL
async function fetchHTML(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });
    return data;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    throw new Error(`Failed to fetch URL: ${error.message}`);
  }
}

// Extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace("www.", "");
  } catch {
    return "unknown";
  }
}

// Calculate page speed (estimate based on content size)
function estimatePageSpeed(html) {
  const sizeKB = html.length / 1024;
  // Rough estimate: larger pages = slower
  if (sizeKB < 300) return 85;
  if (sizeKB < 500) return 75;
  if (sizeKB < 800) return 65;
  return 55;
}

// ============================================
// SCRAPING FUNCTIONS
// ============================================

// Scrape website data
async function scrapeWebsite(url) {
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  // Extract key data
  const title = $("title").text() || "No title found";
  const description = $('meta[name="description"]').attr("content") || "";
  const h1Count = $("h1").length;
  const images = $("img").length;
  const productImages = $(
    "img[alt*='product'], img[alt*='Product'], img[class*='product']"
  ).length;
  const hasSSL = url.startsWith("https");
  const hasAbout = html.toLowerCase().includes("about us");
  const hasFAQ = html.toLowerCase().includes("faq");
  const hasContactInfo =
    html.toLowerCase().includes("contact") ||
    html.toLowerCase().includes("support");
  const hasReturnPolicy =
    html.toLowerCase().includes("return") ||
    html.toLowerCase().includes("refund");
  const hasLiveChat = html.includes("tawk") || html.includes("drift");
  const hasSchema =
    html.includes("schema.org") || html.includes("@context");

  // Extract product descriptions (rough count of paragraphs with product keywords)
  const paragraphs = $("p").length;
  const descriptions = $("p")
    .text()
    .toLowerCase()
    .match(/feature|benefit|spec|material|size|color|quality/gi) || [];

  return {
    title,
    description,
    h1Count,
    images,
    productImages,
    hasSSL,
    hasAbout,
    hasFAQ,
    hasContactInfo,
    hasReturnPolicy,
    hasLiveChat,
    hasSchema,
    paragraphs,
    descriptionQuality: descriptions.length,
    pageSize: html.length,
    domain: extractDomain(url),
  };
}

// Scrape Amazon product data (public data only)
async function scrapeAmazonASIN(asin) {
  try {
    const url = `https://www.amazon.com/dp/${asin}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    // Extract publicly visible data
    const title = $("span.a-size-large.product-title-wordbreak").text() ||
      $("h1 span").text() || "Unknown";
    const rating =
      parseFloat(
        $("span.a-star-small span a-star-small")
          .text()
          .match(/(\d+\.\d+)/)?.[1]
      ) || 0;
    const reviewCount = parseInt(
      $("span#acrCustomerReviewCount")
        .text()
        .match(/(\d+)/)?.[1]
    ) || 0;
    const price =
      $("span.a-price-whole").first().text().replace(/[$,]/g, "") || "N/A";

    return {
      asin,
      title,
      rating,
      reviewCount,
      price,
      url,
      found: true,
    };
  } catch (error) {
    return {
      asin,
      found: false,
      error: error.message,
    };
  }
}

// ============================================
// SCORING ENGINE
// ============================================

function scoreProductDataQuality(websiteData) {
  let score = 0;
  let maxScore = 100;
  let details = [];

  // Image count (target: 6+ images)
  if (websiteData.images >= 6) {
    score += 20;
    details.push({
      plus: true,
      text: `Good image count: ${websiteData.images} images`,
      impact: "High visibility signal",
    });
  } else if (websiteData.images >= 3) {
    score += 10;
    details.push({
      plus: false,
      text: `Only ${websiteData.images} images (target: 6+)`,
      impact: "Missing visibility opportunity",
    });
  } else {
    details.push({
      plus: false,
      text: `Too few images: ${websiteData.images}`,
      impact: "-5% visibility",
    });
  }

  // Product images specifically
  if (websiteData.productImages >= 3) {
    score += 15;
    details.push({
      plus: true,
      text: `${websiteData.productImages} dedicated product images`,
      impact: "Better conversion potential",
    });
  } else {
    score -= 5;
    details.push({
      plus: false,
      text: `Only ${websiteData.productImages} product-specific images`,
      impact: "-3% conversion",
    });
  }

  // Description quality
  if (websiteData.descriptionQuality > 50) {
    score += 20;
    details.push({
      plus: true,
      text: `Rich descriptions with specifications`,
      impact: "Better SEO + conversion",
    });
  } else if (websiteData.descriptionQuality > 20) {
    score += 10;
    details.push({
      plus: false,
      text: `Descriptions could be more detailed`,
      impact: "-3% conversion",
    });
  } else {
    score -= 10;
    details.push({
      plus: false,
      text: `Minimal product descriptions`,
      impact: "-8% conversion",
    });
  }

  // Schema markup
  if (websiteData.hasSchema) {
    score += 15;
    details.push({
      plus: true,
      text: `Schema markup detected`,
      impact: "Better Google parsing",
    });
  } else {
    details.push({
      plus: false,
      text: `No schema markup found`,
      impact: "-2% Google Shopping visibility",
    });
  }

  // Page structure
  if (websiteData.h1Count === 1) {
    score += 10;
    details.push({
      plus: true,
      text: `Good heading structure (1 H1)`,
      impact: "Better SEO",
    });
  } else if (websiteData.h1Count > 1) {
    score -= 5;
    details.push({
      plus: false,
      text: `Multiple H1 tags (${websiteData.h1Count})`,
      impact: "Confuses search engines",
    });
  }

  return {
    score: Math.min(score, 100),
    maxScore,
    details,
    category: "Product Data & Content Quality",
    impact: "+12-18% visibility",
  };
}

function scoreReviewMetrics(amazonData) {
  let score = 50;
  let details = [];

  if (!amazonData.found) {
    return {
      score: 0,
      maxScore: 100,
      details: [
        {
          plus: false,
          text: `ASIN not found or not provided`,
          impact: "Cannot assess Amazon visibility",
        },
      ],
      category: "Review Authority & Trust",
      impact: "N/A - No Amazon listing found",
      amazonData: null,
    };
  }

  // Rating
  if (amazonData.rating >= 4.5) {
    score += 25;
    details.push({
      plus: true,
      text: `Strong rating: ${amazonData.rating}/5 stars`,
      impact: "Top quartile visibility",
    });
  } else if (amazonData.rating >= 4.0) {
    score += 15;
    details.push({
      plus: true,
      text: `Good rating: ${amazonData.rating}/5 stars`,
      impact: "Competitive",
    });
  } else if (amazonData.rating >= 3.5) {
    score += 5;
    details.push({
      plus: false,
      text: `Below average: ${amazonData.rating}/5 stars`,
      impact: "-5% visibility",
    });
  } else {
    details.push({
      plus: false,
      text: `Poor rating: ${amazonData.rating}/5 stars`,
      impact: "-15% visibility",
    });
  }

  // Review count
  if (amazonData.reviewCount >= 200) {
    score += 25;
    details.push({
      plus: true,
      text: `Strong review volume: ${amazonData.reviewCount} reviews`,
      impact: "Trust signal to buyers",
    });
  } else if (amazonData.reviewCount >= 50) {
    score += 15;
    details.push({
      plus: true,
      text: `Decent review volume: ${amazonData.reviewCount} reviews`,
      impact: "Building credibility",
    });
  } else if (amazonData.reviewCount >= 10) {
    score += 5;
    details.push({
      plus: false,
      text: `Limited reviews: ${amazonData.reviewCount}`,
      impact: "-10% visibility",
    });
  } else {
    details.push({
      plus: false,
      text: `Very few reviews: ${amazonData.reviewCount}`,
      impact: "-20% visibility, low trust",
    });
  }

  // Review velocity indicator (can't measure directly, but we note low counts)
  if (amazonData.reviewCount > 0 && amazonData.reviewCount < 20) {
    details.push({
      plus: false,
      text: `Low review velocity (need more reviews)`,
      impact: "-8% visibility",
    });
  }

  return {
    score: Math.min(score, 100),
    maxScore: 100,
    details,
    category: "Review Authority & Trust",
    impact: "+15-25% visibility, +10-20% conversion",
    amazonData,
  };
}

function scorePricingStrategy(amazonData) {
  let score = 60;
  let details = [];

  if (!amazonData.found || amazonData.price === "N/A") {
    return {
      score: 50,
      maxScore: 100,
      details: [
        {
          plus: false,
          text: `Price data unavailable`,
          impact: "Cannot assess competitiveness",
        },
      ],
      category: "Pricing & Competitive Positioning",
      impact: "Unknown",
      amazonData: null,
    };
  }

  const price = parseFloat(amazonData.price);

  // Generic pricing assessment (without real competitors)
  if (price > 0 && price < 50) {
    score += 15;
    details.push({
      plus: true,
      text: `Budget-friendly price: $${price}`,
      impact: "Larger addressable market",
    });
  } else if (price >= 50 && price < 200) {
    score += 20;
    details.push({
      plus: true,
      text: `Mid-range price: $${price}`,
      impact: "Sweet spot for margins + volume",
    });
  } else {
    score += 10;
    details.push({
      plus: true,
      text: `Premium price: $${price}`,
      impact: "Target affluent segment",
    });
  }

  details.push({
    plus: false,
    text: `Price competitiveness: Cannot compare without competitor data`,
    impact: "Need to analyze similar products",
  });

  return {
    score: Math.min(score, 100),
    maxScore: 100,
    details,
    category: "Pricing & Competitive Positioning",
    impact: "+5-12% visibility, +15-35% conversion",
    amazonData,
  };
}

function scoreTrustSignals(websiteData) {
  let score = 0;
  let details = [];

  if (websiteData.hasSSL) {
    score += 20;
    details.push({
      plus: true,
      text: `SSL/HTTPS detected`,
      impact: "Basic security requirement met",
    });
  } else {
    details.push({
      plus: false,
      text: `No SSL certificate (HTTP)`,
      impact: "Major trust issue, -20% conversion",
    });
  }

  if (websiteData.hasAbout) {
    score += 20;
    details.push({
      plus: true,
      text: `About Us page found`,
      impact: "Brand storytelling present",
    });
  } else {
    details.push({
      plus: false,
      text: `No About Us page`,
      impact: "-5% conversion (buyers want context)",
    });
  }

  if (websiteData.hasFAQ) {
    score += 15;
    details.push({
      plus: true,
      text: `FAQ section present`,
      impact: "Reduces support friction",
    });
  } else {
    details.push({
      plus: false,
      text: `No FAQ section`,
      impact: "-5% conversion (questions unanswered)",
    });
  }

  if (websiteData.hasContactInfo) {
    score += 20;
    details.push({
      plus: true,
      text: `Contact info accessible`,
      impact: "Trust signal to buyers",
    });
  } else {
    details.push({
      plus: false,
      text: `Contact info hard to find`,
      impact: "-3% conversion, support friction",
    });
  }

  if (websiteData.hasReturnPolicy) {
    score += 15;
    details.push({
      plus: true,
      text: `Return policy visible`,
      impact: "Removes purchase friction",
    });
  } else {
    details.push({
      plus: false,
      text: `Return policy unclear or missing`,
      impact: "-8% conversion",
    });
  }

  if (websiteData.hasLiveChat) {
    score += 10;
    details.push({
      plus: true,
      text: `Live chat/support detected`,
      impact: "+3-8% conversion",
    });
  }

  return {
    score: Math.min(score, 100),
    maxScore: 100,
    details,
    category: "Trust, Credibility & Support",
    impact: "+8-18% conversion, +5-12% repeat purchases",
  };
}

function scoreKeywordOptimization(websiteData) {
  let score = 50;
  let details = [];

  // Title tag analysis
  if (websiteData.title && websiteData.title.length > 30) {
    score += 15;
    details.push({
      plus: true,
      text: `Title tag present and descriptive`,
      impact: "Better CTR in search results",
    });
  } else {
    details.push({
      plus: false,
      text: `Title tag too short or generic`,
      impact: "-3% CTR",
    });
  }

  // Meta description
  if (websiteData.description && websiteData.description.length > 100) {
    score += 15;
    details.push({
      plus: true,
      text: `Meta description complete`,
      impact: "Better search result display",
    });
  } else {
    details.push({
      plus: false,
      text: `Meta description missing or too short`,
      impact: "-2% CTR",
    });
  }

  // Heading structure
  if (websiteData.h1Count === 1) {
    score += 15;
    details.push({
      plus: true,
      text: `Proper heading hierarchy detected`,
      impact: "Better keyword relevance signal",
    });
  }

  // Schema markup helps keywords
  if (websiteData.hasSchema) {
    score += 10;
    details.push({
      plus: true,
      text: `Schema markup aids keyword parsing`,
      impact: "+2-3% Google visibility",
    });
  } else {
    details.push({
      plus: false,
      text: `No schema markup found`,
      impact: "-5% keyword visibility",
    });
  }

  details.push({
    plus: false,
    text: `Limited keyword analysis (need specific ASIN for Amazon keywords)`,
    impact: "Provide Amazon ASIN for keyword gap analysis",
  });

  return {
    score: Math.min(score, 100),
    maxScore: 100,
    details,
    category: "Keyword Optimization & SEO",
    impact: "+8-15% visibility, +20-30% discoverability",
  };
}

function scoreTechnicalPerformance(websiteData) {
  let score = 0;
  let details = [];

  const speedScore = estimatePageSpeed(websiteData.pageSize);

  if (speedScore >= 80) {
    score += 25;
    details.push({
      plus: true,
      text: `Fast page load (estimated: ${speedScore}/100)`,
      impact: "+5-10% conversion",
    });
  } else if (speedScore >= 60) {
    score += 15;
    details.push({
      plus: true,
      text: `Moderate page speed (estimated: ${speedScore}/100)`,
      impact: "Acceptable",
    });
  } else {
    score -= 10;
    details.push({
      plus: false,
      text: `Slow page load (estimated: ${speedScore}/100)`,
      impact: "-15% conversion, -5% SEO ranking",
    });
  }

  // Image count affects performance
  if (websiteData.images > 15) {
    details.push({
      plus: false,
      text: `Many images (${websiteData.images}) may slow page`,
      impact: "-3-5% conversion on slow networks",
    });
  }

  // SSL
  if (websiteData.hasSSL) {
    score += 15;
    details.push({
      plus: true,
      text: `HTTPS/SSL enabled`,
      impact: "Security + ranking boost",
    });
  } else {
    score -= 10;
    details.push({
      plus: false,
      text: `Not using HTTPS`,
      impact: "-20% conversion, -10% SEO",
    });
  }

  details.push({
    plus: false,
    text: `Detailed metrics limited (Core Web Vitals require live testing)`,
    impact: "Use Google PageSpeed Insights for full analysis",
  });

  return {
    score: Math.min(Math.max(score, 0), 100),
    maxScore: 100,
    details,
    category: "Technical Performance & Site Health",
    impact: "+5-15% conversion, +3-8% SEO ranking",
  };
}

// ============================================
// API ENDPOINTS
// ============================================

app.post("/api/audit", async (req, res) => {
  try {
    const { websiteUrl, amazonASIN } = req.body;

    if (!websiteUrl) {
      return res.status(400).json({ error: "Website URL required" });
    }

    // Validate URL format
    let url = websiteUrl;
    if (!url.startsWith("http")) {
      url = `https://${url}`;
    }

    console.log(`Starting audit for: ${url}`);

    // Scrape website
    const websiteData = await scrapeWebsite(url);
    console.log("Website data scraped");

    // Scrape Amazon data if ASIN provided
    let amazonData = null;
    if (amazonASIN) {
      amazonData = await scrapeAmazonASIN(amazonASIN);
      console.log("Amazon data scraped");
    }

    // Run scoring on each category
    const scores = [
      scoreProductDataQuality(websiteData),
      scoreReviewMetrics(amazonData || {}),
      scorePricingStrategy(amazonData || {}),
      scoreTrustSignals(websiteData),
      scoreKeywordOptimization(websiteData),
      scoreTechnicalPerformance(websiteData),
    ];

    // Calculate overall score
    const overallScore = Math.round(
      scores.reduce((sum, s) => sum + s.score, 0) / scores.length
    );

    // Generate recommendations
    const allNegatives = scores
      .flatMap((s) => s.details.filter((d) => !d.plus))
      .slice(0, 10);

    const recommendations = allNegatives
      .map((neg) => ({
        issue: neg.text,
        impact: neg.impact,
        priority: "HIGH",
      }))
      .sort((a, b) => {
        const aImpact = parseFloat(a.impact.match(/\d+/)?.[0] || 0);
        const bImpact = parseFloat(b.impact.match(/\d+/)?.[0] || 0);
        return bImpact - aImpact;
      });

    const report = {
      overallScore,
      domain: websiteData.domain,
      websiteUrl: url,
      amazonASIN: amazonASIN || null,
      timestamp: new Date().toISOString(),
      categories: scores,
      topRecommendations: recommendations.slice(0, 5),
      allDetails: scores.flatMap((s) => ({
        category: s.category,
        ...s,
      })),
    };

    res.json(report);
  } catch (error) {
    console.error("Audit error:", error);
    res.status(500).json({
      error: error.message,
      details: "Failed to complete audit. Check URL and try again.",
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Test: POST http://localhost:${PORT}/api/audit`);
});
