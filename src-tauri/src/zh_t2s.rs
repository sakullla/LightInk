//! Character-level Traditional-to-Simplified conversion for Wiktionary extracts.
//!
//! Mapping is derived from OpenCC `TSCharacters.txt` (Apache-2.0,
//! https://github.com/BYVoid/OpenCC). Phrase-level OpenCC rules are omitted;
//! dictionary extracts are overwhelmingly 1:1 character conversions.

use std::collections::HashMap;
use std::sync::OnceLock;

const PAIRS: &str = include_str!("zh-t2s.txt");

fn table() -> &'static HashMap<char, char> {
    static TABLE: OnceLock<HashMap<char, char>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut map = HashMap::with_capacity(4096);
        for line in PAIRS.lines() {
            let mut chars = line.chars();
            if let (Some(from), Some(to)) = (chars.next(), chars.next()) {
                map.insert(from, to);
            }
        }
        map
    })
}

pub fn to_simplified(input: &str) -> String {
    let map = table();
    input
        .chars()
        .map(|ch| map.get(&ch).copied().unwrap_or(ch))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::to_simplified;

    #[test]
    fn converts_wiktionary_traditional_definition() {
        assert_eq!(
            to_simplified("基於動物身體最外層硬化而形成的骨骼系統"),
            "基于动物身体最外层硬化而形成的骨骼系统"
        );
        assert_eq!(to_simplified("名詞"), "名词");
        assert_eq!(to_simplified("hello 牙齒"), "hello 牙齿");
    }
}
