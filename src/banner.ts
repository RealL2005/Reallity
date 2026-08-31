import figlet from "figlet";

export function renderBanner(
  text = "Reallity",
  font: "Small" | "Standard" = "Standard",
): string {
  return figlet.textSync(text, {
    font,
    horizontalLayout: "default",
    verticalLayout: "default",
  });
}
