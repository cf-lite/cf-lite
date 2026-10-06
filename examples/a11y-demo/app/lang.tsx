import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "vi";

export const messages = {
  en: {
    skip: "Skip to main content", site: "Accessibility demo", navLabel: "Main", home: "Home", form: "Form", live: "Live list",
    langLabel: "Language", footer: "Synthetic demo page for screen reader testing. Nothing you type is sent anywhere.",
    homeTitle: "Accessibility demo", homeIntro: "This page has landmarks, headings and links to test with a screen reader.",
    section1: "What to listen for", section2: "Where to go next",
    formTitle: "Sign-up form", name: "Name", email: "Email", send: "Send",
    errName: "Name is required.", errEmail: "Enter an email address like name@example.com.", errSummary: "Please fix 2 errors", errOne: "Please fix 1 error",
    okMsg: "Thanks, the form is valid. Nothing was sent.",
    liveTitle: "Live list", liveIntro: "Press the button to add an item. A polite status message announces each change.",
    add: "Add item", clear: "Clear list", item: "Item", added: "added. Total:", cleared: "List cleared.", empty: "The list is empty.",
  },
  vi: {
    skip: "Chuyển tới nội dung chính", site: "Trang thử nghiệm trợ năng", navLabel: "Chính", home: "Trang chủ", form: "Biểu mẫu", live: "Danh sách động",
    langLabel: "Ngôn ngữ", footer: "Trang mẫu để thử trình đọc màn hình. Không có gì bạn nhập được gửi đi.",
    homeTitle: "Trang thử nghiệm trợ năng", homeIntro: "Trang này có vùng, tiêu đề và liên kết để thử với trình đọc màn hình.",
    section1: "Cần lắng nghe điều gì", section2: "Đi tới đâu tiếp",
    formTitle: "Biểu mẫu đăng ký", name: "Tên", email: "Email", send: "Gửi",
    errName: "Cần nhập tên.", errEmail: "Nhập địa chỉ email dạng ten@example.com.", errSummary: "Hãy sửa 2 lỗi", errOne: "Hãy sửa 1 lỗi",
    okMsg: "Cảm ơn, biểu mẫu hợp lệ. Không có gì được gửi đi.",
    liveTitle: "Danh sách động", liveIntro: "Nhấn nút để thêm một mục. Thông báo trạng thái nhẹ nhàng đọc mỗi thay đổi.",
    add: "Thêm mục", clear: "Xóa danh sách", item: "Mục", added: "đã thêm. Tổng:", cleared: "Đã xóa danh sách.", empty: "Danh sách trống.",
  },
} satisfies Record<Lang, Record<string, string>>;

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: Record<keyof (typeof messages)["en"], string> }>(null as never);
export const useLang = () => useContext(Ctx);

/** Keeps `<html lang>` in step with the visible language so a screen reader switches voice. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return <Ctx.Provider value={{ lang, setLang, t: messages[lang] }}>{children}</Ctx.Provider>;
}
