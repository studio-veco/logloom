// この Mac が鳴らしている音を、そのまま取り出す係。
//
// **Google Meet や Zoom に、記録用の参加者を入れずに議事録を取るため。**
// 会議の道具に人を1人足すやり方は、相手の画面に「誰か入ってきた」と出るうえ、
// 会社によっては外部の道具を会議に入れること自体が禁じられている。
// この Mac が耳で聞いている音をそのまま拾えば、相手からは何も見えない。
//
// macOS 13 から入った ScreenCaptureKit を使う。画面録画の仕組みだが、
// **音だけを取り出せる**（画面は 2×2 の大きさにして捨てる）。
// 別の音の入口（BlackHole など）を入れなくてよいのが大きい。入れるには
// 管理者の許可が要り、Mac の音の出し先も付け替えることになる。
//
// 出すもの：16kHz・モノラル・16ビットの生の音。引数に書き出し先を渡せばそこへ、
// 渡さなければ標準出力へ。logloom の listen.mjs が ffmpeg と同じ形で読む。
//
// 許可について。**「画面収録」の許可は、このプログラムを起こした親に紐づく。**
// logloom を Claude のアプリの中から起こすと、許可の相手は Claude のアプリになり、
// そこで断られていると、node をいくら起こし直しても断られたままになる（実測）。
//
// そこで、これは**単体のアプリの形（.app）にして、LaunchServices から起こす**。
// そうすると親の鎖から外れ、このプログラム自身に許可が紐づく。一度許可を出せば、
// logloom をターミナルから起こしてもアプリから起こしても同じように動く。
// アプリから起こすと標準出力が受け取れないので、名前付きパイプ越しに渡す。

import AVFoundation
import Foundation
import ScreenCaptureKit

let RATE = 16000.0

final class Tap: NSObject, SCStreamOutput, SCStreamDelegate {
  let out: FileHandle

  init(out: FileHandle) {
    self.out = out
    super.init()
  }

  // **ScreenCaptureKit は sampleRate の指定を聞いてくれない。**
  // 16000 を頼んでも 48000 で返ってきた（実測：4.4秒の音が 13.24秒ぶんの量で届いた）。
  // 届いた音の本当の刻みを読んで、ここで 16000 に落とす。
  // 落とし方は線形の内挿。**つなぎ目の位相を持ち越す**ので、buffer の境目でも段差が出ない。
  private var phase: Double = 0
  private var tail: Float = 0
  private var haveTail = false

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, CMSampleBufferDataIsReady(buffer) else { return }
    let frames = Int(CMSampleBufferGetNumSamples(buffer))
    guard frames > 0 else { return }

    // ScreenCaptureKit は 32 ビットの小数で返す。16 ビットの整数に直す。
    // 何本で返ってくるかは決まっていないので、足して本数で割り、1本にする
    var mixed = [Float](repeating: 0, count: frames)
    var lanes = 0

    try? buffer.withAudioBufferList { list, _ in
      for ab in list {
        guard let data = ab.mData else { continue }
        let ch = max(1, Int(ab.mNumberChannels))
        let n = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
        let p = data.bindMemory(to: Float.self, capacity: n)
        let count = min(frames, n / ch)
        if ch == 1 {
          for k in 0..<count { mixed[k] += p[k] }
        } else {
          for k in 0..<count {
            var s: Float = 0
            for c in 0..<ch { s += p[k * ch + c] }
            mixed[k] += s / Float(ch)
          }
        }
        lanes += 1
      }
    }
    guard lanes > 0 else { return }

    let scale = 1.0 / Float(lanes)
    for k in 0..<frames { mixed[k] *= scale }

    // 届いた刻み。読めないときは 48000 とみなす（実測でそうだった）
    var inRate = 48000.0
    if let desc = CMSampleBufferGetFormatDescription(buffer),
       let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee,
       asbd.mSampleRate > 0 {
      inRate = asbd.mSampleRate
    }
    let step = inRate / RATE

    var pcm = Data(capacity: Int(Double(frames) / step) * 2 + 4)
    var t = phase
    while t < Double(frames) {
      let i = Int(t.rounded(.down))
      let frac = Float(t - Double(i))
      let a: Float = i == -1 ? (haveTail ? tail : mixed[0]) : mixed[max(0, min(frames - 1, i))]
      let b: Float = mixed[max(0, min(frames - 1, i + 1))]
      let v = max(-1.0, min(1.0, a + (b - a) * frac))
      var s = Int16(v * 32767)
      withUnsafeBytes(of: &s) { pcm.append(contentsOf: $0) }
      t += step
    }
    phase = t - Double(frames)
    tail = mixed[frames - 1]
    haveTail = true
    if !pcm.isEmpty { write(pcm) }
  }

  /** 受け手が閉じたら（logloom が止まったら）、こちらも終わる */
  private func write(_ d: Data) {
    do { try out.write(contentsOf: d) } catch { exit(0) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("syscap: 止まりました：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(2)
  }
}

@main
struct Main {
  static func main() async {
    do {
      // 画面の一覧を取る。**ここで許可が無ければ弾かれる**ので、分かる字で伝える
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let display = content.displays.first else {
        FileHandle.standardError.write("syscap: 画面が見つかりません\n".data(using: .utf8)!)
        exit(3)
      }

      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let conf = SCStreamConfiguration()
      conf.capturesAudio = true
      conf.sampleRate = 48000          // 16000 を頼んでも聞いてもらえない。落とすのはこちらでやる
      conf.channelCount = 1
      // 画面は要らない。いちばん小さくして捨てる
      conf.width = 2
      conf.height = 2
      conf.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      conf.excludesCurrentProcessAudio = true
      conf.queueDepth = 6

      // 書き出し先。引数があればそこへ（名前付きパイプ）、無ければ標準出力へ
      var sink = FileHandle.standardOutput
      let args = CommandLine.arguments
      if args.count > 1 {
        let p = args[1]
        guard let h = FileHandle(forWritingAtPath: p) else {
          FileHandle.standardError.write("syscap: \(p) に書けません\n".data(using: .utf8)!)
          exit(4)
        }
        sink = h
      }

      let tap = Tap(out: sink)
      let stream = SCStream(filter: filter, configuration: conf, delegate: tap)
      try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "syscap.audio"))
      try await stream.startCapture()
      FileHandle.standardError.write("syscap: この Mac の音を拾っています\n".data(using: .utf8)!)

      // 親が閉じるまで動き続ける
      while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
    } catch {
      FileHandle.standardError.write("syscap: \(error.localizedDescription)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
