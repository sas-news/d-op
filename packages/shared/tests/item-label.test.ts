import { describe, expect, it } from "vitest"
import { episodeLeadLabel } from "../src/item-label"

// episodeLeadLabel backs both the extension popup/options rows and the Share
// web clip list: number+title lead, dup numbers dropped, sane fallbacks.
describe("episodeLeadLabel", () => {
  it("joins a bare episode number and title", () => {
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "猫猫", episodeNumber: "1" })).toBe(
      "1 猫猫",
    )
  })

  it("keeps the 第N話 number ahead of the title", () => {
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "猫猫", episodeNumber: "第1話" })).toBe(
      "第1話 猫猫",
    )
  })

  it("drops the number when the title opens with 第{num}話", () => {
    expect(
      episodeLeadLabel({ title: "作品", episodeTitle: "第1話 猫猫", episodeNumber: "1" }),
    ).toBe("第1話 猫猫")
    expect(
      episodeLeadLabel({
        title: "作品",
        episodeTitle: "第28話 それは人間らしい",
        episodeNumber: "28",
      }),
    ).toBe("第28話 それは人間らしい")
  })

  it("drops the number when the title opens with the same token", () => {
    expect(
      episodeLeadLabel({ title: "作品", episodeTitle: "第1話 猫猫", episodeNumber: "第1話" }),
    ).toBe("第1話 猫猫")
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "1話", episodeNumber: "1" })).toBe("1話")
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "第1話", episodeNumber: "第1話" })).toBe(
      "第1話",
    )
  })

  it("does not claim a different leading number as a duplicate", () => {
    expect(
      episodeLeadLabel({ title: "作品", episodeTitle: "10話 特別編", episodeNumber: "1" }),
    ).toBe("1 10話 特別編")
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "第11話", episodeNumber: "1" })).toBe(
      "1 第11話",
    )
  })

  it("falls back to the work title, then the placeholder", () => {
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "" })).toBe("作品")
    expect(episodeLeadLabel({ title: "作品", episodeTitle: "", episodeNumber: "3" })).toBe("3")
    expect(episodeLeadLabel({ title: "", episodeTitle: "" })).toBe("(タイトル不明)")
  })
})
