defmodule Srv do
  def start(base, n) do
    for i <- 0..(n - 1), do: spawn_link(fn -> listen(base + i) end)
    Process.sleep(:infinity)
  end

  def listen(port) do
    {:ok, l} =
      :gen_tcp.listen(port, [:binary, packet: :line, active: false, reuseaddr: true,
                             backlog: 4096, nodelay: true, ip: {127, 0, 0, 1}, buffer: 8192])
    accept(l)
  end

  def accept(l) do
    case :gen_tcp.accept(l) do
      {:ok, s} ->
        pid = spawn(fn -> receive do :go -> start_loop(s) end end)
        :ok = :gen_tcp.controlling_process(s, pid)
        send(pid, :go)
        accept(l)
      _ -> accept(l)
    end
  end

  def start_loop(s) do
    :inet.setopts(s, active: :once)
    await(s)
  end

  def await(s) do
    receive do
      {:tcp, ^s, line} ->
        try do
          m = :json.decode(line)
          _ = length(Map.get(m, "samples", []))
        catch
          _, _ -> :ok
        end
        :gen_tcp.send(s, "A\n")
        :inet.setopts(s, active: :once)
        :erlang.hibernate(__MODULE__, :await, [s])
      _ -> :gen_tcp.close(s)
    end
  end
end

[base, n] = System.argv() |> Enum.map(&String.to_integer/1)
Srv.start(base, n)
