describe("Old Tokens Dashboard", () => {
  it("loads and displays old tokens table", () => {
    cy.visit("/trading/old-tokens");
    cy.contains("Old Tokens Analytics & Manual Trading").should("be.visible");
    cy.get("table").should("exist");
  });
});
