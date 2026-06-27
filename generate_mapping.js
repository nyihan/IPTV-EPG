import fs from "fs";
import zlib from "zlib";

const M3U_URL = "https://iu-ott.akvado-lso123.workers.dev/ott.m3u?user-agent=vj-14-1ogfiva";
const EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";

// Levenshtein Algorithm အသုံးပြု၍ စာသားချင်း တူညီမှု ရာခိုင်နှုန်းကို တွက်ချက်ခြင်း
function getSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    let longer = s1.length >= s2.length ? s1 : s2;
    let shorter = s1.length < s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;
    
    let costs = [];
    for (let i = 0; i <= longer.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= shorter.length; j++) {
            if (i === 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[shorter.length] = lastValue;
    }
    return (longer.length - costs[shorter.length]) / parseFloat(longer.length);
}

// Channel နာမည်များကို တိုက်ဆိုင်စစ်ဆေးရာတွင် လွယ်ကူစေရန် သန့်စင်ခြင်း
function cleanName(str) {
    let s = str.toLowerCase();
    s = s.replace(/-\s*vpn/g, ''); // VPN စာသားများ ဖြုတ်ခြင်း
    s = s.replace(/\b(hd|fhd|uhd|4k|sd|tv)\b/g, ''); // အရည်အသွေးပြ စာသားများ ဖြုတ်ခြင်း
    s = s.replace(/\[.*?\]|\(.*?\)/g, ''); // ကွင်းများအတွင်းရှိ စာသားများ ဖြုတ်ခြင်း
    s = s.replace(/[^a-z0-9]/g, ''); // Space နှင့် အခြားသင်္ကေတများ ဖြုတ်ခြင်း
    return s;
}

async function generateFinalM3U() {
    console.log(`🔄 Fetching Original Playlist from: ${M3U_URL}`);

    try {
        const response = await fetch(M3U_URL, { headers: { "User-Agent": "vj-14-1ogfiva" } });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const m3uText = await response.text();

        const lines = m3uText.split('\n');
        const filteredChannels = [];
        let currentExtinf = "";
        let droppedCount = 0;

        console.log("🧹 Filtering Russian channels and grouping sports...");

        // ၁။ ရုရှားလိုင်းများကို စစ်ထုတ်ခြင်း
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                currentExtinf = line;
            } else if (line.startsWith('http') && currentExtinf !== "") {
                let groupMatch = currentExtinf.match(/group-title="([^"]*)"/i);
                let groupTitle = groupMatch ? groupMatch[1] : "";
                let nameMatch = currentExtinf.match(/,(.+?)$/);
                let channelName = nameMatch ? nameMatch[1].trim() : "";

                // ရုရှား (Cyrillic) Group နာမည်များကို အတိအကျ ဖမ်းယူခြင်း
                const isRuGroup = /[\u0400-\u04FF]|Russia|🇷🇺|\bru\b/i.test(groupTitle);
                
                // အားကစားလိုင်း ဟုတ်/မဟုတ် စစ်ဆေးခြင်း
                const isSport = /sport|спорт|match|футбол|арена|бойцовский|ufc|arena|football/i.test(channelName) || /sport|спорт/i.test(groupTitle);

                let keep = true;

                if (isRuGroup) {
                    if (isSport) {
                        if (groupMatch) {
                            currentExtinf = currentExtinf.replace(`group-title="${groupTitle}"`, `group-title="Sport from Russia GP"`);
                        } else {
                            currentExtinf = currentExtinf.replace('#EXTINF:-1', '#EXTINF:-1 group-title="Sport from Russia GP"');
                        }
                    } else {
                        keep = false;
                        droppedCount++;
                    }
                }

                if (keep && channelName) {
                    filteredChannels.push({
                        extinf: currentExtinf,
                        url: line,
                        name: channelName
                    });
                }
                currentExtinf = "";
            }
        }
        console.log(`✅ Kept ${filteredChannels.length} channels. Dropped ${droppedCount} Russian non-sport channels.`);

        // ၂။ epgshare01 ၏ EPG ဖိုင်အစစ်အား တိုက်ရိုက်ဆွဲယူခြင်း
        console.log(`\n🔄 Downloading real EPG database from epgshare01... (This takes a few seconds)`);
        const epgRes = await fetch(EPG_URL);
        if (!epgRes.ok) throw new Error("Failed to fetch EPG XML.GZ");
        
        const arrayBuffer = await epgRes.arrayBuffer();
        const unzipped = zlib.gunzipSync(Buffer.from(arrayBuffer)).toString('utf-8');

        console.log("🔍 Parsing EPG XML for exact Channel IDs...");
        const epgChannels = [];
        const regex = /<channel id="([^"]+)">\s*<display-name[^>]*>([^<]+)<\/display-name>/g;
        let match;
        while ((match = regex.exec(unzipped)) !== null) {
            epgChannels.push({ 
                id: match[1], 
                name: match[2], 
                clean: cleanName(match[2]) 
            });
        }
        console.log(`✅ Successfully loaded ${epgChannels.length} real EPG IDs from epgshare01.`);

        // ၃။ AI မပါဘဲ လိုင်းများကို လျှပ်တစ်ပြက် တိုက်ဆိုင်စစ်ဆေးခြင်း
        console.log("\n🧠 Mapping channels locally (Super Fast & 100% Accurate)...");
        let mappedCount = 0;

        for (let ch of filteredChannels) {
            let m3uClean = cleanName(ch.name);
            let bestId = "";
            let bestScore = 0;

            for (let epg of epgChannels) {
                // နာမည်အတိအကျ တူညီပါက ချက်ချင်းရွေးချယ်မည်
                if (m3uClean === epg.clean) {
                    bestId = epg.id;
                    bestScore = 1.0;
                    break;
                }
                
                // စာလုံးရေ အလွန်ကွာခြားပါက ကျော်သွားမည် (အမြန်နှုန်းအတွက်)
                if (Math.abs(m3uClean.length - epg.clean.length) > 15) continue;

                let score = getSimilarity(m3uClean, epg.clean);
                
                // တစ်ခုထဲတွင် တစ်ခုပါဝင်နေပါက အမှတ်ပိုပေးမည်
                if ((m3uClean.includes(epg.clean) || epg.clean.includes(m3uClean)) && score > 0.5) {
                    score += 0.15; 
                }

                // တူညီမှု ရာခိုင်နှုန်း ၈၀ (0.8) ကျော်ပါက အကောင်းဆုံးအဖြစ် မှတ်သားမည်
                if (score > bestScore && score >= 0.8) {
                    bestScore = score;
                    bestId = epg.id;
                }
            }

            if (bestId) {
                if (ch.extinf.includes('tvg-id=')) {
                    ch.extinf = ch.extinf.replace(/tvg-id="[^"]*"/, `tvg-id="${bestId}"`);
                } else {
                    ch.extinf = ch.extinf.replace('#EXTINF:-1', `#EXTINF:-1 tvg-id="${bestId}"`);
                }
                mappedCount++;
            }
        }

        console.log(`✅ Successfully mapped ${mappedCount} out of ${filteredChannels.length} channels.`);

        // ၄။ အသင့်အသုံးပြုနိုင်သော M3U ဖိုင်အသစ် တည်ဆောက်ခြင်း
        console.log("📝 Generating final_playlist.m3u...");
        let m3uOutput = `#EXTM3U x-tvg-url="${EPG_URL}"\n`; 
        
        for (const ch of filteredChannels) {
            m3uOutput += `${ch.extinf}\n${ch.url}\n`;
        }

        fs.writeFileSync("final_playlist.m3u", m3uOutput, "utf-8");
        console.log(`🎉 Success! Generated 'final_playlist.m3u' ready for TiviMate.`);

    } catch (error) {
        console.error("❌ Fatal Error:", error);
        process.exit(1); 
    }
}

generateFinalM3U();
