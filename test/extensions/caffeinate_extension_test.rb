require "test_helper"
require "open3"

class CaffeinateExtensionTest < Minitest::Test
  EXTENSION = File.expand_path("../../extensions/caffeinate.ts", __dir__)
  UPSTREAM_SHA = "3a7629bd3bb119cea6f428e1fca751c4f7089934"
  UPSTREAM_HEADER = %r{Vendored from https://github\.com/forlorn-echo/pi-caffeinate at\n// #{UPSTREAM_SHA}}

  def test_bounded_sleep_assertion_lifecycle_is_registered
    vendored = read_extension
    header, body = split_header(vendored)
    assert_match(UPSTREAM_HEADER, header)
    assert_includes body, 'if (process.platform !== "darwin") return;'
    assert_includes body, 'spawn(CAFFEINATE_COMMAND, ["-i", "-t", String(ASSERTION_TIMEOUT_SECONDS)]'
    assert_includes body, 'pi.on("agent_start"'
    assert_includes body, 'pi.on("agent_settled"'
    assert_includes body, 'pi.on("session_shutdown"'
    assert_includes body, "refreshTimer.unref?.();"
  end

  def test_caffeinate_lifecycle_and_release_with_unrelated_assertion
    skip "caffeinate lifecycle test requires macOS" unless macos?
    skip "caffeinate command is not available" unless command?("caffeinate")

    unrelated_pid = Process.spawn("caffeinate", "-i", "-t", "120", out: File::NULL, err: File::NULL)
    output, status = Open3.capture2e("node", "--input-type=module", "-e", harness)

    assert status.success?, output
    assert_match(/caffeinate lifecycle ok/, output)
  ensure
    terminate(unrelated_pid)
  end

  private

  def read_extension
    File.read(EXTENSION)
  end

  def split_header(content)
    lines = content.lines
    header = lines.take_while { |line| line.start_with?("//") }.join
    [header, lines.drop_while { |line| line.start_with?("//") }.join]
  end

  def macos?
    RUBY_PLATFORM.include?("darwin")
  end

  def command?(name)
    ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).any? do |directory|
      path = File.join(directory, name)
      File.executable?(path) && !File.directory?(path)
    end
  end

  def terminate(pid)
    return unless pid

    Process.kill("TERM", pid)
    Process.wait(pid)
  rescue Errno::ESRCH, Errno::ECHILD
    nil
  end

  def harness
    <<~JS
      import caffeinate from #{EXTENSION.inspect};

      const { EventEmitter } = await import("node:events");
      const handlers = {};
      const events = new EventEmitter();
      let totalActive = 0;
      let deferReplies = false;
      const pendingReplies = [];
      events.on("subagents:rpc:v1:request", ({ requestId }) => {
        const reply = () => events.emit(`subagents:rpc:v1:reply:${requestId}`, {
          version: 1, requestId, success: true,
          data: { fleet: { version: 1, totalActive } },
        });
        if (deferReplies) pendingReplies.push(reply);
        else queueMicrotask(reply);
      });
      const fakePi = {
        on: (event, handler) => { (handlers[event] ??= []).push(handler); },
        getAllTools: () => [{ name: "subagent" }],
        events: {
          on(name, handler) {
            events.on(name, handler);
            return () => events.off(name, handler);
          },
          emit: (name, data) => events.emit(name, data),
        },
      };
      const ctx = { hasUI: false, ui: { notify: () => {} } };

      caffeinate(fakePi);
      for (const event of ["agent_start", "agent_settled", "session_shutdown"]) {
        if (!handlers[event]?.length) throw new Error(`missing ${event} handler`);
      }

      const { execFileSync } = await import("node:child_process");
      const { setTimeout: delay } = await import("node:timers/promises");
      // Only this harness's children belong to the extension under test. Other Pi
      // sessions may legitimately hold their own caffeinate assertions.
      const assertions = () => {
        let out = "";
        try {
          out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf-8" });
        } catch { return []; }
        return out.split("\\n").map((line) => line.trim()).filter(Boolean)
          .filter((line) => {
            const [, parentPid, ...args] = line.split(/\\s+/);
            return parentPid === String(process.pid) && args.join(" ").startsWith("caffeinate -i");
          });
      };
      const waitFor = async (want, label, timeout = 5000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
          const found = assertions();
          if (want ? found.length : !found.length) return found;
          if (Date.now() > deadline) throw new Error(`${label}: still [${found.join(" | ")}]`);
          await delay(100);
        }
      };

      handlers.agent_start[0]({}, ctx);
      const spawned = await waitFor(true, "caffeinate -i was not spawned on agent_start");
      const pid = spawned[0].split(/\\s+/, 1)[0];
      const args = execFileSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf-8" });
      if (!args.includes("-t 300")) throw new Error("spawned assertion missing bounded timeout");

      handlers.agent_settled[0]({}, ctx);
      await delay(100);
      if (!assertions().some((line) => line.split(/\\s+/, 1)[0] === pid))
        throw new Error("sleep assertion dropped during the agent handoff");

      handlers.agent_start[0]({}, ctx);
      await delay(100);
      if (!assertions().some((line) => line.split(/\\s+/, 1)[0] === pid))
        throw new Error("handoff did not reuse the existing sleep assertion");

      totalActive = 1;
      handlers.agent_settled[0]({}, ctx);
      await delay(32000);
      if (!assertions().some((line) => line.split(/\\s+/, 1)[0] === pid))
        throw new Error("parent sleep assertion expired while its async workflow remained active");

      totalActive = 0;
      events.emit("subagent:async-complete", { id: "workflow" });
      await delay(100);
      if (!assertions().some((line) => line.split(/\\s+/, 1)[0] === pid))
        throw new Error("sleep assertion dropped before the workflow completion wake turn");
      await waitFor(false, "assertion leaked after the idle grace period", 35000);

      handlers.agent_start[0]({}, ctx);
      await waitFor(true, "caffeinate -i was not re-spawned after idle release");
      deferReplies = true;
      handlers.agent_settled[0]({}, ctx);
      handlers.session_shutdown[0]();
      totalActive = 1;
      for (const reply of pendingReplies) reply();
      await delay(100);
      await waitFor(false, "assertion leaked or restarted after session_shutdown");
      for (const channel of ["subagent:async-started", "subagent:async-complete", "subagent:process-terminal"]) {
        if (events.listenerCount(channel) !== 0)
          throw new Error(`listener leaked after session_shutdown: ${channel}`);
      }

      console.log("caffeinate lifecycle ok");
      process.exit(0);
    JS
  end
end
