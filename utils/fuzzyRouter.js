/**
 * Extracts the first valid number from a messy string.
 * Example: "I think 1 please" -> "1"
 */
function extractNumber(text, validOptions = ['1', '2', '3']) {
  const match = text.match(/\d+/); // Finds the first sequence of digits
  if (match && validOptions.includes(match[0])) {
    return match[0];
  }
  return null; // Return null if no valid number is found
}

/**
 * Scans the text for category keywords. 
 * If it finds multiple (e.g., "electrician and plumber"), it returns the one mentioned FIRST.
 */
function detectCategoryIntent(text) {
  const lowerText = text.toLowerCase();
  
  const categories = [
    { name: 'Electrical', keywords: ['electric', 'light', 'spark', 'wire', 'power', 'socket'] },
    { name: 'Plumbing', keywords: ['plumb', 'pipe', 'water', 'leak', 'tap', 'sink'] },
    { name: 'Carpentry', keywords: ['carpent', 'wood', 'furniture', 'door', 'cabinet', 'table'] }
  ];

  let earliestMatch = { category: null, index: Infinity };

  for (const cat of categories) {
    for (const word of cat.keywords) {
      const index = lowerText.indexOf(word);
      if (index !== -1 && index < earliestMatch.index) {
        earliestMatch = { category: cat.name, index: index };
      }
    }
  }

  return earliestMatch.category; // Returns 'Electrical', 'Plumbing', 'Carpentry', or null
}

module.exports = { extractNumber, detectCategoryIntent };
