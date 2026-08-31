import figlet from "figlet";

export function renderBanner(text = "Reallity"): string {
  return figlet.textSync(text, {
    font: "Standard",
    horizontalLayout: "default",
    verticalLayout: "default",
  });
}
