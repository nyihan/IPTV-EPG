import fs from "fs";
import zlib from "zlib";
import readline from "readline";
import { Readable } from "stream";

const M3U_URL = "https://iu-ott.akvado-lso123.workers.dev/ott.m3u?user-agent=vj-14-1ogfiva";
const EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";

// စာသားချင်း တူညီမှု ရာခိုင်နှုန်းကို တွက်ချက်ခြင်း
function getSimilarity(s1, s2) {
    if (!s1 || !s2) return 0;
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

// Channel နာမည်များကို အတိအကျတိုက်စစ်နိုင်ရန် သန့်စင်ခြင်း
function cleanName(str) {
    if (!str) return "";
    let s = str.toLowerCase();
    s = s.replace(/-\s*vpn/g, ''); 
    s = s.replace(/\b(hd|fhd|uhd|4k|sd|tv|plus)\b/g, ''); 
    s = s.replace(/\[.*?\]|\(.*?\)/g, ''); 
    s = s.replace(/[^a-z0-9]/g, ''); 
    return s.trim();
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

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                currentExtinf = line;
            } else if (line.startsWith('http') && currentExtinf !== "") {
                let groupMatch = currentExtinf.match(/group-title="([^"]*)"/i);
                let groupTitle = groupMatch ? groupMatch[1] : "";
                let nameMatch = currentExtinf.match(/,(.+?)$/);
                let channelName = nameMatch ? nameMatch[1].trim() : "";

                const isRuGroup = /[\u0400-\u04FF]|Russia|🇷🇺|\bru\b/i.test(groupTitle);
                const isSport = /sport|спорт|match|футбол|арена|бойцовский|ufc|arena|football/i.test(channelName) || /sport|спорт/i.test(groupTitle);

                let keep = true;

                if (isRuGroup) {
                    if (isSport) {
                        if (groupMatch) {
                            currentExtinf = currentExtinf.replace(`group-title="${groupTitle}"`, `group-title="Sport from Russia GP"`);
                        } else {
                            // ကော်မာ (,) ရှေ့တွင် group-title ထည့်သွင်းခြင်း (ပိုမိုလုံခြုံသောနည်းလမ်း)
                            let lastComma = currentExtinf.lastIndexOf(',');
                            if (lastComma !== -1) {
                                currentExtinf = currentExtinf.substring(0, lastComma) + ` group-title="Sport from Russia GP"` + currentExtinf.substring(lastComma);
                            }
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

        console.log(`\n🔄 Downloading and parsing real EPG database from epgshare01 (Stream Mode)...`);
        const epgRes = await fetch(EPG_URL);
        if (!epgRes.ok) throw new Error("Failed to fetch EPG XML.GZ");
        
        const epgChannels = [];
        const gunzip = zlib.createGunzip();
        const nodeStream = Readable.fromWeb(epgRes.body).pipe(gunzip);
        const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

        let currentId = null;
        
        for await (const line of rl) {
            if (line.includes('<channel id=')) {
                const idMatch = line.match(/<channel id="([^"]+)">/);
                if (idMatch) currentId = idMatch[1];
                
                if (currentId && line.includes('<display-name')) {
                    const nameMatch = line.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    if (nameMatch) {
                        // Display Name သာမက Channel ID အစစ်ကိုပါ သန့်စင်ပြီး ရှာဖွေရာတွင် အသုံးပြုရန် မှတ်သားထားမည်
                        let pureId = currentId.split('.')[0]; 
                        epgChannels.push({ 
                            id: currentId, 
                            name: nameMatch[1], 
                            clean: cleanName(nameMatch[1]),
                            cleanId: cleanName(pureId) 
                        });
                        currentId = null;
                    }
                }
            } else if (currentId && line.includes('<display-name')) {
                const nameMatch = line.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                if (nameMatch) {
                    let pureId = currentId.split('.')[0];
                    epgChannels.push({ 
                        id: currentId, 
                        name: nameMatch[1], 
                        clean: cleanName(nameMatch[1]),
                        cleanId: cleanName(pureId)
                    });
                    currentId = null;
                }
            } else if (line.includes('</channel>')) {
                currentId = null;
            }
        }
        console.log(`✅ Successfully loaded ${epgChannels.length} real EPG IDs from epgshare01.`);

        console.log("\n🧠 Mapping channels locally (Super Fast & 100% Accurate)...");
        let mappedCount = 0;

        for (let ch of filteredChannels) {
            let m3uClean = cleanName(ch.name);
            let bestId = "";
            let bestScore = 0;

            for (let epg of epgChannels) {
                // Name (သို့) ID တစ်ခုခုနှင့် ကွက်တိတူပါက ချက်ချင်းရွေးမည်
                if (m3uClean === epg.clean || m3uClean === epg.cleanId) {
                    bestId = epg.id;
                    bestScore = 1.0;
                    break;
                }
                
                // စာလုံးရေကွာဟချက် စစ်ဆေးခြင်း
                if (Math.abs(m3uClean.length - epg.clean.length) > 15 && Math.abs(m3uClean.length - epg.cleanId.length) > 15) continue;

                // Name ရော ID ကိုပါ တိုက်စစ်ပြီး အမှတ်အများဆုံးကို ယူမည်
                let score1 = getSimilarity(m3uClean, epg.clean);
                let score2 = getSimilarity(m3uClean, epg.cleanId);
                let maxScore = Math.max(score1, score2);
                
                if ((m3uClean.includes(epg.clean) || epg.clean.includes(m3uClean) || m3uClean.includes(epg.cleanId)) && maxScore > 0.5) {
                    maxScore += 0.15; 
                }

                if (maxScore > bestScore && maxScore >= 0.8) {
                    bestScore = maxScore;
                    bestId = epg.id;
                }
            }

            // TVG-ID ကို 100% ဝင်စေရန် (ကော်မာမတိုင်မီ) ကြားညှပ်ထည့်သွင်းခြင်း
            if (bestId) {
                if (ch.extinf.includes('tvg-id=')) {
                    ch.extinf = ch.extinf.replace(/tvg-id="[^"]*"/, `tvg-id="${bestId}"`);
                } else {
                    let lastCommaIdx = ch.extinf.lastIndexOf(',');
                    if (lastCommaIdx !== -1) {
                        ch.extinf = ch.extinf.substring(0, lastCommaIdx) + ` tvg-id="${bestId}"` + ch.extinf.substring(lastCommaIdx);
                    }
                }
                mappedCount++;
            }
        }

        console.log(`✅ Successfully mapped ${mappedCount} out of ${filteredChannels.length} channels.`);

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
